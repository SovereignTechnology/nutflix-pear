#!/usr/bin/env bash
# Spike S-D: the iroh helper against nfxd through S5′'s NAT matrix, in network namespaces.
# CI only, as root (.github/workflows/spike-iroh.yml runs it with sudo), never on a developer's
# machine. AGPL-3.0-or-later.
#
# The topology and the routers (`router`, `topology`) are lifted from nfx's spike S5′,
# crates/spikes/s5-hyperdht/nat/run.sh at nfx main 29019d2 (AGPL-3.0-or-later, as this
# repository), so the iroh helper is judged on the matrix HyperDHT was (nfx ADR 0103 §3):
#
#   sdpub  10.200.0.1/24 (bridge): the iroh relay (HTTP, :3340) and a scoped Nostr relay (:7447)
#   sdra   router A: 10.200.0.11 up, 192.168.10.1 down, nft masquerade
#   sdrb   router B: 10.200.0.12 up, 192.168.20.1 down, nft masquerade
#   sdha   host A 192.168.10.2 behind A, the server (seeder)
#   sdhb   host B 192.168.20.2 behind B, the client (fetcher)
#
# A "consistent" router masquerades keeping the source port (endpoint-independent mapping); a
# "symmetric" one masquerades fully-random. Unsolicited inbound traffic is dropped.
#
# Every cell runs the four pairings server ∈ {nfxd, helper} × client ∈ {nfxd, helper}; nfxd⇄nfxd
# is the control. Each pairing gets a fresh scoped relay with the manifest republished and only
# its own seeder alive, so a fetch can only have come from the server under test. Which path the
# bytes took is read from nft counters on router B (the client's), the same for both
# implementations: UDP from anything but the relay is direct, TCP from the relay's :3340 is
# relayed.
#
#   open-open                  must succeed, direct
#   consistent-consistent      must succeed; the path is recorded (holepunching needs the relay's
#                              QUIC address discovery, off on an HTTP relay: spike S-D unknown 1)
#   symmetric-symmetric        must succeed, through the relay
#   symmetric-symmetric-norelay  must FAIL: no relay configured on either side
#   consistent-symmetric       must succeed; the path is recorded
#   open-open poison           helper ← helper with one segment's bytes flipped: must fail
#                              "poisoned" and store nothing (sha256 is checked in JS)
#
# Results: $OUT/nat.jsonl, one line per check. Exit 1 if a judged check failed.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
out=${OUT:-$here/results}
work=${WORK:-$(mktemp -d)}
mkdir -p "$out" "$work"
: > "$out/nat.jsonl"
NODE=${NODE:-$(command -v node)}
HELPER=${HELPER:?the helper binary}
NFXD=${NFXD:?the nfxd binary}
NFX_PACKAGE=${NFX_PACKAGE:?the nfx-package binary}
IROH_RELAY=${IROH_RELAY:?the iroh-relay binary}
HARNESS=$here/harness.mjs
RELAY_IP=10.200.0.1
IROH_URL=http://10.200.0.1:3340/
NOSTR_URL=ws://10.200.0.1:7447
NS=nfx:regtest:1
VIDEO_ID=spike-sd-clip
TIMEOUT=${TIMEOUT:-90}

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 0.5
  for p in "${pids[@]}"; do kill -KILL -- "-$p" 2>/dev/null || true; done
  for n in sdpub sdra sdrb sdha sdhb; do ip netns del "$n" 2>/dev/null || true; done
}
trap cleanup EXIT

# start NAME NETNS CMD...: in its own session (so its whole group can be stopped), output to
# $out/NAME.{out,err}. Prints nothing; the pid is the last entry of pids.
start() {
  local name=$1 ns=$2
  shift 2
  setsid ip netns exec "$ns" "$@" > "$out/$name.out" 2> "$out/$name.err" &
  pids+=($!)
}
stop() { # pid
  kill -TERM -- "-$1" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done
  kill -KILL -- "-$1" 2>/dev/null || true
}
wait_for() { # file pattern seconds
  for _ in $(seq 1 $(( $3 * 10 ))); do grep -qE "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  return 1
}
wait_port() { # netns ip port seconds
  for _ in $(seq 1 $(( $4 * 10 ))); do
    ip netns exec "$1" bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null && return 0
    sleep 0.1
  done
  return 1
}
# Peak resident memory (VmHWM, KiB) of the nfxd and helper processes in a session, read before
# it is stopped: {"nfxd": N, "nutflix-iroh-h": N}.
session_rss() { # session leader pid
  local p c v out=""
  for p in $(ps -o pid= -s "$1" 2>/dev/null); do
    c=$(cat "/proc/$p/comm" 2>/dev/null) || continue
    case $c in nfxd|nutflix-iroh-h*) ;; *) continue ;; esac
    v=$(awk '/^VmHWM:/{print $2}' "/proc/$p/status" 2>/dev/null || true)
    [ -n "$v" ] && out+="\"$c\":$v,"
  done
  echo "{${out%,}}"
}
json() { python3 -c "$1" "${@:2}"; }

failed=0
# record CHECK JUDGED(yes|no) EXPECT(ok|fail) PATH(direct|relay|any|-) ERROR(-|code) JSON
record() {
  local line verdict
  line=$(json 'import json,sys
d=json.loads(sys.argv[6]); expect,path,err=sys.argv[3],sys.argv[4],sys.argv[5]
ok = d.get("ok") is True
if expect == "ok": passed = ok and (path in ("any","-") or d.get("path") == path)
else: passed = (not ok) and (err == "-" or d.get("error") == err)
d.update(check=sys.argv[1], judged=sys.argv[2]=="yes", expect=expect, expect_path=path, passed=passed)
print(json.dumps(d))' "$@")
  echo "$line" >> "$out/nat.jsonl"
  verdict=$(json 'import json,sys; print("yes" if json.loads(sys.argv[1])["passed"] else "no")' "$line")
  if [ "$verdict" = yes ]; then echo "PASS $1"
  elif [ "$2" = yes ]; then echo "FAIL $1: $line"; failed=1
  else echo "INFO $1: $line"
  fi
}

# --- routers and topology: lifted from nfx spike S5′ (see the header) -------------------------
router() { # a|b consistent|symmetric|open
  local r=$1 flags=""
  [ "$2" = symmetric ] && flags="fully-random"
  if [ "$2" = open ]; then
    # No NAT: plain routing, every LAN host reachable (the baseline).
    ip netns exec "sdr$r" nft flush ruleset
    return
  fi
  ip netns exec "sdr$r" nft -f - <<EOF
flush ruleset
table ip nat {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "up-$r" masquerade $flags
  }
}
table inet filter {
  # A real NAT answers nothing unsolicited: drop it, so no ICMP unreachable goes back.
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "up-$r" ct state new drop
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "down-$r" oifname "up-$r" accept
  }
}
EOF
}

RELAY_PID=
topology() { # mode-a mode-b
  if [ -n "$RELAY_PID" ]; then stop "$RELAY_PID"; fi
  for n in sdpub sdra sdrb sdha sdhb; do ip netns del "$n" 2>/dev/null || true; done
  for n in sdpub sdra sdrb sdha sdhb; do
    ip netns add "$n"
    ip -n "$n" link set lo up
  done
  ip -n sdpub link add br0 type bridge
  ip -n sdpub addr add 10.200.0.1/24 dev br0
  ip -n sdpub link set br0 up
  local r up lan
  for r in a b; do
    [ "$r" = a ] && { up=10.200.0.11; lan=192.168.10; } || { up=10.200.0.12; lan=192.168.20; }
    ip link add "up-$r" netns "sdr$r" type veth peer name "pub-$r" netns sdpub
    ip -n sdpub link set "pub-$r" master br0 up
    ip -n "sdr$r" addr add "$up/24" dev "up-$r"
    ip -n "sdr$r" link set "up-$r" up
    ip link add "down-$r" netns "sdr$r" type veth peer name eth0 netns "sdh$r"
    ip -n "sdr$r" addr add "$lan.1/24" dev "down-$r"
    ip -n "sdr$r" link set "down-$r" up
    ip -n "sdh$r" addr add "$lan.2/24" dev eth0
    ip -n "sdh$r" link set eth0 up
    ip -n "sdh$r" route add default via "$lan.1"
    ip netns exec "sdr$r" sysctl -qw net.ipv4.ip_forward=1
    ip netns exec "sdr$r" sysctl -qw net.ipv4.conf.all.rp_filter=0
  done
  # Routes for the open/open baseline, where the LANs are routed instead of masqueraded.
  ip -n sdpub route add 192.168.10.0/24 via 10.200.0.11
  ip -n sdpub route add 192.168.20.0/24 via 10.200.0.12
  ip -n sdra route add 192.168.20.0/24 via 10.200.0.12
  ip -n sdrb route add 192.168.10.0/24 via 10.200.0.11
  router a "$1"
  router b "$2"
  # The network's own iroh relay, over HTTP (as nfx's Phase A exit run).
  start "iroh-relay-$1-$2" sdpub "$IROH_RELAY" --config-path "$work/iroh-relay.toml"
  RELAY_PID=${pids[-1]}
  wait_port sdpub "$RELAY_IP" 3340 20 || echo "iroh relay not listening on :3340" >&2
}
# ------------------------------------------------------------------------------------------------

# A byte meter on router B, beside (never inside) the NAT tables, reset for every pairing.
meter_reset() {
  ip netns exec sdrb nft delete table inet meter 2>/dev/null || true
  ip netns exec sdrb nft -f - <<EOF
table inet meter {
  counter direct {}
  counter relayed {}
  chain fwd {
    type filter hook forward priority filter - 10; policy accept;
    iifname "up-b" ip saddr $RELAY_IP tcp sport 3340 counter name relayed
    iifname "up-b" ip saddr != $RELAY_IP meta l4proto udp counter name direct
  }
}
EOF
}
meter_read() { # → {"direct_bytes":N,"relayed_bytes":N}
  ip netns exec sdrb nft -j list counters table inet meter | json 'import json,sys
c={}
for o in json.load(sys.stdin)["nftables"]:
    k=o.get("counter")
    if k: c[k["name"]+"_bytes"]=k.get("bytes",0)
print(json.dumps(c))'
}

# A fresh scoped relay (NFX-04, nfxd's embedded one) in sdpub, with the manifest published to it.
nostr_up() { # dir
  mkdir -p "$1/relay-store"
  start "${1##*/}-nostr" sdpub "$NFXD" run --store "$1/relay-store" --embed-relay "$RELAY_IP:7447" \
    --namespace "$NS"
  wait_for "$out/${1##*/}-nostr.err" 'embedded relay: ws://' 30 || return 1
  ip netns exec sdpub "$NFXD" publish --key "$work/creator.key" --relay "$NOSTR_URL" \
    --package "$work/pkg" --title "spike S-D" > /dev/null 2>> "$out/${1##*/}-publish.err"
}

# client IMPL NAME DIR RELAY_ARGS...: starts the fetcher in sdhb and waits until it is watching.
client() {
  local impl=$1 name=$2 dir=$3 relay=$4
  case $impl in
    helper)
      start "$name-client" sdhb "$NODE" "$HARNESS" fetch --helper "$HELPER" --state "$dir/client" \
        --iroh-relay "$relay" --nostr "$NOSTR_URL" --a "$A" --timeout "$TIMEOUT"
      wait_for "$out/$name-client.out" '"watching"' 40 ;;
    nfxd)
      "$NFXD" key new "$dir/fetcher.key" > /dev/null
      mkdir -p "$dir/client-store"
      local extra=()
      [ "$relay" = none ] || extra=(--iroh-relay "$relay")
      start "$name-client" sdhb "$NFXD" run \
        --key "$dir/fetcher.key" --store "$dir/client-store" --state "$dir/client-state" \
        --relay "$NOSTR_URL" --fetch "$A" "${extra[@]}"
      wait_for "$out/$name-client.err" "$A: Fetching" 40 ;;
  esac
}

server() { # IMPL NAME DIR RELAY [--poison]
  local impl=$1 name=$2 dir=$3 relay=$4 poison=${5:-}
  case $impl in
    helper)
      start "$name-server" sdha "$NODE" "$HARNESS" serve --helper "$HELPER" --state "$dir/server" \
        --iroh-relay "$relay" --nostr "$NOSTR_URL" --package "$work/pkg" --a "$A" ${poison:+--poison}
      wait_for "$out/$name-server.out" '"ready"|"ok": ?false' 60 ;;
    nfxd)
      "$NFXD" key new "$dir/seeder.key" > /dev/null
      cp -r "$work/pkg/store" "$dir/server-store"
      local extra=()
      [ "$relay" = none ] || extra=(--iroh-relay "$relay")
      start "$name-server" sdha "$NFXD" run \
        --key "$dir/seeder.key" --store "$dir/server-store" --state "$dir/server-state" \
        --relay "$NOSTR_URL" --seed "$A" "${extra[@]}"
      wait_for "$out/$name-server.err" "$A: Seeding" 60 ;;
  esac
}

# The client's verdict as JSON, once it has one (or the deadline passes).
outcome() { # IMPL NAME DIR
  local impl=$1 name=$2 dir=$3
  case $impl in
    helper)
      wait_for "$out/$name-client.out" '"ok":' $(( TIMEOUT + 15 )) || true
      grep -E '"ok":' "$out/$name-client.out" | tail -1 || echo '{"ok":false,"error":"no result"}' ;;
    nfxd)
      if wait_for "$out/$name-client.err" "$A: Seeding" $(( TIMEOUT + 15 )); then
        echo '{"ok":true}'
      else
        local last
        last=$(grep -F "$A:" "$out/$name-client.err" | tail -1 | sed "s|$A: ||" || true)
        json 'import json,sys; print(json.dumps({"ok":False,"error":"no Seeding in time","last":sys.argv[1]}))' "${last:-none}"
      fi ;;
  esac
}

pairing() { # CELL JUDGED EXPECT PATH ERROR SERVER CLIENT RELAY [--poison]
  local cell=$1 judged=$2 expect=$3 path=$4 err=$5 srv=$6 cli=$7 relay=$8 poison=${9:-}
  local name="$cell-$cli-from-$srv${poison:+-poison}" dir t0 t1 res meter sready cpid spid
  dir="$work/$name"
  mkdir -p "$dir"
  local mark=${#pids[@]}
  if ! nostr_up "$dir"; then
    record "$name" "$judged" "$expect" "$path" "$err" '{"ok":false,"error":"harness: no scoped relay"}'
    return
  fi
  meter_reset
  if ! client "$cli" "$name" "$dir" "$relay"; then
    record "$name" "$judged" "$expect" "$path" "$err" '{"ok":false,"error":"harness: client never watched"}'
  else
    cpid=${pids[-1]}
    t0=$(date +%s%N)
    sready=yes
    server "$srv" "$name" "$dir" "$relay" "$poison" || sready=no
    spid=${pids[-1]}
    res=$(outcome "$cli" "$name" "$dir")
    t1=$(date +%s%N)
    meter=$(meter_read || echo "{}")
    res=$(json 'import json,sys
d=json.loads(sys.argv[1]); m=json.loads(sys.argv[2]); v=int(sys.argv[3])
d["server_ready"]=sys.argv[8]=="yes"
d["server_rss_kib"]=json.loads(sys.argv[9]); d["client_rss_kib"]=json.loads(sys.argv[10])
d.update(m); d["wall_ms"]=(int(sys.argv[5])-int(sys.argv[4]))//1000000
dr,rl=m.get("direct_bytes",0),m.get("relayed_bytes",0)
d["path"]="direct" if dr>=0.9*v else ("relay" if rl>=0.9*v else ("mixed" if dr+rl>=0.9*v else "none"))
if d.get("ok") is True and d["wall_ms"]>0 and "mbit_s" not in d: d["mbit_s"]=round(v*8/(d["wall_ms"]/1000)/1e6,1)
d["server"],d["client"]=sys.argv[6],sys.argv[7]
print(json.dumps(d))' "$res" "$meter" "$VIDEO_BYTES" "$t0" "$t1" "$srv" "$cli" "$sready" \
      "$(session_rss "$spid")" "$(session_rss "$cpid")")
    record "$name" "$judged" "$expect" "$path" "$err" "$res"
  fi
  # Stop this pairing's processes (relay, client, server), newest first.
  local i
  for (( i=${#pids[@]}-1; i>=mark; i-- )); do stop "${pids[$i]}"; unset "pids[$i]"; done
  pids=("${pids[@]}")
}

pairings() { # CELL JUDGED EXPECT PATH RELAY
  local srv cli
  for srv in nfxd helper; do
    for cli in nfxd helper; do
      pairing "$1" "$2" "$3" "$4" - "$srv" "$cli" "$5"
    done
  done
}

# --- the content: one clip, packaged once by nfx-package, published by one creator key ---------
cat > "$work/iroh-relay.toml" <<EOF
enable_relay = true
http_bind_addr = "$RELAY_IP:3340"
enable_quic_addr_discovery = false
enable_metrics = false
EOF
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t "${CLIP_SECONDS:-30}" -c:v libx264 \
  -preset ultrafast -pix_fmt yuv420p -c:a aac "$work/clip.mp4"
"$NFX_PACKAGE" "$work/clip.mp4" --video "$NS:$VIDEO_ID" --out "$work/pkg" --max-height 720 \
  --preset veryfast > "$out/package.json"
creator=$("$NFXD" key new "$work/creator.key" | head -1)
A="38504:$creator:$NS:$VIDEO_ID"
VIDEO_BYTES=$(json 'import os,re,sys
d=sys.argv[1]; print(sum(os.path.getsize(os.path.join(d,f)) for f in os.listdir(d) if re.fullmatch("[0-9a-f]{64}",f)))' "$work/pkg/store")
echo "{\"check\":\"content\",\"a\":\"$A\",\"bytes\":$VIDEO_BYTES,\"package\":$(cat "$out/package.json" | tr -d '\n')}" >> "$out/nat.jsonl"
echo "content: $VIDEO_BYTES bytes, $A"

topology open open
pairings open-open yes ok direct "$IROH_URL"
pairing open-open yes fail - poisoned helper helper "$IROH_URL" --poison

topology consistent consistent
pairings consistent-consistent yes ok any "$IROH_URL"

topology symmetric symmetric
pairings symmetric-symmetric yes ok relay "$IROH_URL"
pairings symmetric-symmetric-norelay yes fail - none

topology consistent symmetric
pairings consistent-symmetric yes ok any "$IROH_URL"

exit "$failed"
