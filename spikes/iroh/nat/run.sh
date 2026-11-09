#!/usr/bin/env bash
# Spike S-D: the iroh helper against nfxd through S5′'s NAT matrix, in network namespaces.
# CI only, as root (.github/workflows/spike-iroh.yml runs it with sudo), never on a developer's
# machine. AGPL-3.0-or-later.
#
# The topology and the routers (`router`, `topology`) are lifted from nfx's spike S5′,
# crates/spikes/s5-hyperdht/nat/run.sh at nfx main 29019d2 (AGPL-3.0-or-later, as this
# repository), so the iroh helper is judged on the matrix HyperDHT was (nfx ADR 0103 §3):
#
#   sdpub  10.200.0.1/24 (bridge): the iroh relay (HTTP :3340, TLS :3443) and a Nostr relay (:7447)
#   sdra   router A: 10.200.0.11 up, 192.168.10.1 down, nft masquerade
#   sdrb   router B: 10.200.0.12 up, 192.168.20.1 down, nft masquerade
#   sdha   host A 192.168.10.2 behind A, the server (seeder)
#   sdhb   host B 192.168.20.2 behind B, the client (fetcher)
#   sdps   10.200.0.21 on the bridge, no NAT: the public-seeder cells' server
#
# A "consistent" router masquerades keeping the source port (endpoint-independent mapping); a
# "symmetric" one masquerades fully-random. Unsolicited inbound traffic is dropped. A "forward"
# router is consistent and also forwards one UDP port (10.200.0.11:7843 to 192.168.10.2:7843): a
# seeder behind a port forward, the shape of a seeder in a guest behind a host's DNAT.
#
# Every cell runs the four pairings server ∈ {nfxd, helper} × client ∈ {nfxd, helper}; nfxd⇄nfxd
# is the control. Each pairing gets a fresh Nostr relay with the manifest republished and only
# its own seeder alive, so a fetch can only have come from the server under test. Which path the
# bytes took is read from nft counters on router B (the client's), the same for both
# implementations: UDP from anything but the relay's address is direct, TCP from the iroh relay's
# :3340/:3443 is relayed, and TCP from the Nostr relay's :7447 is counted apart (nostr_bytes),
# never as relayed.
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
# Then, spike S-D unknown 1, the same NATs behind a TLS relay with QUIC address discovery on
# (a CI CA, given to the helper as `relay_cas` and to nfxd as `--iroh-relay-ca`, nfx #18): the
# address discovery holepunching needs. All four pairings, judged:
#   consistent-consistent-qad  must succeed, direct (holepunched)
#   symmetric-symmetric-tls    must succeed, through the TLS relay
#   consistent-symmetric-qad   must succeed; the path is recorded
#
# Then nfx #30's groundwork (before the TLS cells): Nostr-only cells, no iroh relay on either side,
# so the only infrastructure is a Nostr relay. Each asserts today's outcome, so a change in it
# (nfx #30's coordinated punch, a port mapping) shows up as a failed check to re-judge:
#   open-open-norelay             must succeed, direct
#   consistent-consistent-norelay must FAIL today: no first path (no relay, so no QUIC address
#                                 discovery and no hole punch) and no port-mapping gateway here
#   consistent-symmetric-norelay  must FAIL today, likewise (symmetric-symmetric-norelay above)
#   pubseed-{consistent,symmetric}-norelay   the seeder on a public address (sdps), the fetcher
#                                 behind NAT: must succeed, direct
#   fwdseed-symmetric-noflags     nfxd behind a port forward, without --iroh-bind/--iroh-external:
#                                 must FAIL (it binds a random port and advertises only its LAN
#                                 address), the control for the next two
#   fwdseed-{consistent,symmetric}-norelay   the same nfxd with --iroh-bind 192.168.10.2:7843
#                                 --iroh-external 10.200.0.11:7843 (nfx N1): must succeed, direct.
#                                 SKIPPED when the nfxd under test lacks the flags (read from its
#                                 usage text); the NFX_SHA bump that brings N1 turns them on
# and the same with a stock Nostr relay (strfry, $STRFRY, its own default strfry.conf with only
# db/bind/port changed) in place of nfxd's scoped relay: manifests (kind 38504) and beacons (kind
# 20464) must pass through it unchanged.
#   stock-open-open-norelay, stock-pubseed-symmetric-norelay   must succeed, direct
#   stock-fwdseed-symmetric-norelay                            must succeed, direct (needs N1)
# A stock-relay pairing also records what the relay stored and refused (strfry scan, its log).
#
# An expected failure passes only with the seeder up (server_ready), so a harness fault never
# counts as one. Results: $OUT/nat.jsonl, one line per check (skips included); a table at the end.
# Exit 1 if a judged check failed.
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
STRFRY=${STRFRY:?the strfry binary (the stock Nostr relay)}
STRFRY_CONF=${STRFRY_CONF:?strfry.conf from the same strfry checkout (its defaults)}
HARNESS=$here/harness.mjs
RELAY_IP=10.200.0.1
PUB_SEEDER_IP=10.200.0.21
# The forwarded port of a "forward" router A, and the seeder's addresses behind it.
FWD_PORT=7843
FWD_BIND=192.168.10.2:$FWD_PORT
FWD_EXTERNAL=10.200.0.11:$FWD_PORT
# Per cell: which Nostr relay (nfxd's scoped one or the stock strfry), the servers it runs, where
# the server sits, and extra `nfxd run` flags for an nfxd server.
NOSTR_IMPL=nfxd
SERVERS="nfxd helper"
SERVER_NS=sdha
SERVER_ARGS=()
# Seconds a client tries in a cell that must fail (nfx #30's cells): short, as a fail-fast
# would be. A success takes a few seconds, so a cell that starts to succeed still shows it.
FAIL_TIMEOUT=${FAIL_TIMEOUT:-45}
IROH_URL=http://10.200.0.1:3340/
IROH_TLS_URL=https://10.200.0.1:3443/
RELAY_KIND=http
CA_HEX=
# Seconds a helper client waits after a fetch before its store is measured again (past the
# helper's 10 s collection): set for the open-open cell, the disk-cap measurement.
EVICT=
NOSTR_URL=ws://10.200.0.1:7447
NS=nfx:regtest:1
VIDEO_ID=spike-sd-clip
TIMEOUT=${TIMEOUT:-90}
NAMESPACES="sdpub sdra sdrb sdha sdhb sdps"

# Does the nfxd under test take nfx N1's flags? Read from its usage text (`nfxd` alone prints it
# and exits 2), never guessed from the pin.
nfxd_usage=$("$NFXD" 2>&1 || true)
if [[ $nfxd_usage == *--iroh-bind* && $nfxd_usage == *--iroh-external* ]]; then N1=yes; else N1=no; fi

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
  sleep 0.5
  for p in "${pids[@]}"; do kill -KILL -- "-$p" 2>/dev/null || true; done
  for n in $NAMESPACES; do ip netns del "$n" 2>/dev/null || true; done
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
# An expected failure counts only with the seeder up: a harness fault (no relay, no server) is
# never the failure a cell asserts.
record() {
  local line verdict
  line=$(json 'import json,sys
d=json.loads(sys.argv[6]); expect,path,err=sys.argv[3],sys.argv[4],sys.argv[5]
ok = d.get("ok") is True
if expect == "ok": passed = ok and (path in ("any","-") or d.get("path") == path)
else: passed = (not ok) and d.get("server_ready") is True and (err == "-" or d.get("error") == err)
d.update(check=sys.argv[1], judged=sys.argv[2]=="yes", expect=expect, expect_path=path, passed=passed)
print(json.dumps(d))' "$@")
  echo "$line" >> "$out/nat.jsonl"
  verdict=$(json 'import json,sys; print("yes" if json.loads(sys.argv[1])["passed"] else "no")' "$line")
  if [ "$verdict" = yes ]; then echo "PASS $1"
  elif [ "$2" = yes ]; then echo "FAIL $1: $line"; failed=1
  else echo "INFO $1: $line"
  fi
}
# skip CHECK EXPECT PATH REASON: a check that cannot run against these binaries, recorded as such
# (never a pass, never a failure) and flagged in the job's annotations.
skip() {
  json 'import json,sys
print(json.dumps({"check":sys.argv[1],"skipped":True,"judged":False,"expect":sys.argv[2],"expect_path":sys.argv[3],"reason":sys.argv[4]}))' \
    "$@" >> "$out/nat.jsonl"
  echo "SKIP $1: $4"
  echo "::notice title=NAT matrix: $1 skipped::$4"
}

# --- routers and topology: lifted from nfx spike S5′ (see the header) -------------------------
router() { # a|b consistent|symmetric|open|forward
  local r=$1 flags="" dnat="" fwd=""
  [ "$2" = symmetric ] && flags="fully-random"
  if [ "$2" = open ]; then
    # No NAT: plain routing, every LAN host reachable (the baseline).
    ip netns exec "sdr$r" nft flush ruleset
    return
  fi
  if [ "$2" = forward ]; then
    # Consistent, plus one forwarded UDP port to host A (added to S5′'s routers: nfx #30's
    # seeder behind a port forward). Only router A forwards.
    [ "$r" = a ] || { echo "router: only router A forwards" >&2; return 1; }
    # (The other routers keep S5′'s rules exactly: no prerouting chain at all.)
    dnat="chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    iifname \"up-$r\" ip daddr ${FWD_EXTERNAL%:*} udp dport $FWD_PORT dnat to $FWD_BIND
  }"
    fwd="iifname \"up-$r\" oifname \"down-$r\" ct status dnat udp dport $FWD_PORT accept"
  fi
  ip netns exec "sdr$r" nft -f - <<EOF
flush ruleset
table ip nat {
  $dnat
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
    $fwd
  }
}
EOF
}

RELAY_PID=
topology() { # mode-a mode-b
  if [ -n "$RELAY_PID" ]; then stop "$RELAY_PID"; fi
  for n in $NAMESPACES; do ip netns del "$n" 2>/dev/null || true; done
  for n in $NAMESPACES; do
    ip netns add "$n"
    ip -n "$n" link set lo up
  done
  ip -n sdpub link add br0 type bridge
  ip -n sdpub addr add 10.200.0.1/24 dev br0
  ip -n sdpub link set br0 up
  # The public seeder's host: on the bridge with its own address, no NAT (added to S5′).
  ip link add eth0 netns sdps type veth peer name pub-s netns sdpub
  ip -n sdpub link set pub-s master br0 up
  ip -n sdps addr add "$PUB_SEEDER_IP/24" dev eth0
  ip -n sdps link set eth0 up
  ip -n sdps route add default via 10.200.0.1
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
  # The network's own iroh relay: over HTTP (as nfx's Phase A exit run), or over TLS with QUIC
  # address discovery (RELAY_KIND=tls).
  start "iroh-relay-$RELAY_KIND-$1-$2" sdpub "$IROH_RELAY" --config-path "$work/iroh-relay-$RELAY_KIND.toml"
  RELAY_PID=${pids[-1]}
  local port=3340
  [ "$RELAY_KIND" = tls ] && port=3443
  wait_port sdpub "$RELAY_IP" "$port" 20 || echo "iroh relay not listening on :$port" >&2
}

# A CI-only CA and a relay certificate for 10.200.0.1, and the TLS relay's config.
tls_setup() {
  local t=$work/tls
  mkdir -p "$t"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
    -subj "/CN=spike S-D CI CA" -keyout "$t/ca.key" -out "$t/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$RELAY_IP" \
    -keyout "$t/relay.key" -out "$t/relay.csr" 2>/dev/null
  printf 'subjectAltName=IP:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n' \
    "$RELAY_IP" > "$t/ext.cnf"
  openssl x509 -req -in "$t/relay.csr" -CA "$t/ca.crt" -CAkey "$t/ca.key" -CAcreateserial \
    -days 2 -extfile "$t/ext.cnf" -out "$t/relay.crt" 2>/dev/null
  CA_HEX=$(openssl x509 -in "$t/ca.crt" -outform DER | od -An -tx1 | tr -d ' \n')
  cat > "$work/iroh-relay-tls.toml" <<EOF
enable_relay = true
http_bind_addr = "$RELAY_IP:3340"
enable_quic_addr_discovery = true
enable_metrics = false
[tls]
cert_mode = "Manual"
manual_cert_path = "$t/relay.crt"
manual_key_path = "$t/relay.key"
https_bind_addr = "$RELAY_IP:3443"
quic_bind_addr = "$RELAY_IP:7842"
EOF
}
# ------------------------------------------------------------------------------------------------

# A byte meter on router B, beside (never inside) the NAT tables, reset for every pairing. Its
# names avoid nft keywords (`meter` and `fwd` both are; S5′ hit the second). Relayed is the iroh
# relay's own traffic only (HTTP :3340, TLS :3443); the Nostr relay shares its address, and its
# :7447 is counted apart, as nostr_bytes (before nfx #30's groundwork it was counted as relayed).
meter_reset() {
  ip netns exec sdrb nft delete table inet sdbytes 2>/dev/null || true
  ip netns exec sdrb nft -f - <<EOF
table inet sdbytes {
  counter direct_bytes {}
  counter relayed_bytes {}
  counter nostr_bytes {}
  chain count_in {
    type filter hook forward priority filter - 10; policy accept;
    iifname "up-b" ip saddr $RELAY_IP tcp sport { 3340, 3443 } counter name relayed_bytes
    iifname "up-b" ip saddr $RELAY_IP tcp sport 7447 counter name nostr_bytes
    iifname "up-b" ip saddr != $RELAY_IP meta l4proto udp counter name direct_bytes
  }
}
EOF
}
meter_read() { # → {"direct_bytes":N,"relayed_bytes":N}
  ip netns exec sdrb nft -j list counters table inet sdbytes | json 'import json,sys
c={}
for o in json.load(sys.stdin)["nftables"]:
    k=o.get("counter")
    if k: c[k["name"]]=k.get("bytes",0)
print(json.dumps(c))'
}

# strfry's own default strfry.conf with only the database, the address and the port changed; it
# fails unless each of the three was found and changed exactly once.
strfry_conf() { # dir
  local conf=$1/strfry.conf
  sed -e "s|^db = \"\./strfry-db/\"\$|db = \"$1/strfry-db/\"|" \
    -e "s|^\( *\)bind = \"127\.0\.0\.1\"\$|\1bind = \"$RELAY_IP\"|" \
    -e "s|^\( *\)port = 7777\$|\1port = 7447|" "$STRFRY_CONF" > "$conf"
  [ "$(grep -cxF "db = \"$1/strfry-db/\"" "$conf")" = 1 ] &&
    [ "$(grep -cE "^ *bind = \"$RELAY_IP\"\$" "$conf")" = 1 ] &&
    [ "$(grep -cE '^ *port = 7447$' "$conf")" = 1 ] ||
    { echo "strfry.conf: db, bind or port not found once in $STRFRY_CONF" >&2; return 1; }
}

# A fresh Nostr relay in sdpub, with the manifest published to it: nfxd's embedded scoped relay
# (NFX-04), or the stock strfry (NOSTR_IMPL=strfry). 0: up and published; 1: no relay; 2: the
# relay is up and the manifest was not published (for a stock relay, a finding: see publish.err).
nostr_up() { # dir
  local base=${1##*/}
  case $NOSTR_IMPL in
    nfxd)
      mkdir -p "$1/relay-store"
      start "$base-nostr" sdpub "$NFXD" run --store "$1/relay-store" --embed-relay "$RELAY_IP:7447" \
        --namespace "$NS"
      wait_for "$out/$base-nostr.err" 'embedded relay: ws://' 30 || return 1 ;;
    strfry)
      mkdir -p "$1/strfry-db"
      strfry_conf "$1" || return 1
      start "$base-nostr" sdpub "$STRFRY" --config="$1/strfry.conf" relay
      wait_port sdpub "$RELAY_IP" 7447 30 || return 1 ;;
  esac
  ip netns exec sdpub "$NFXD" publish --key "$work/creator.key" --relay "$NOSTR_URL" \
    --package "$work/pkg" --title "spike S-D" > /dev/null 2>> "$out/$base-publish.err" || return 2
}

# What a stock relay did in a pairing, as JSON: the manifests (kind 38504) and beacons (kind
# 20464) it holds (strfry keeps ephemeral events for a few minutes), the manifest's stored size
# (strfry's maxEventSize is 65536), and the events its log says it refused.
relay_evidence() { # dir name
  [ "$NOSTR_IMPL" = strfry ] || { echo '{}'; return; }
  local conf=$1/strfry.conf m b
  m=$("$STRFRY" --config="$conf" scan '{"kinds":[38504]}' 2>/dev/null || true)
  b=$("$STRFRY" --config="$conf" scan '{"kinds":[20464]}' 2>/dev/null | grep -c . || true)
  json 'import json,re,sys
m=[l for l in sys.argv[1].splitlines() if l.strip()]
try: log=open(sys.argv[3], errors="replace").read().splitlines()
except OSError: log=[]
refused=[l for l in log if re.search(r"Rejected|blocked|rejecting", l)]
print(json.dumps({"relay":"strfry","relay_manifests":len(m),"manifest_event_bytes":max([len(l.encode()) for l in m], default=0),
  "relay_beacons":int(sys.argv[2] or 0),"relay_refused":len(refused),"relay_refused_first":refused[0][-300:] if refused else None}))' \
    "$m" "${b:-0}" "$out/$2-nostr.err"
}

# client IMPL NAME DIR RELAY_ARGS...: starts the fetcher in sdhb and waits until it is watching.
client() {
  local impl=$1 name=$2 dir=$3 relay=$4
  case $impl in
    helper)
      start "$name-client" sdhb "$NODE" "$HARNESS" fetch --helper "$HELPER" --state "$dir/client" \
        --iroh-relay "$relay" --nostr "$NOSTR_URL" --a "$A" --timeout "$TIMEOUT" \
        ${CA_HEX:+--relay-ca "$CA_HEX"} ${EVICT:+--evict-wait "$EVICT"}
      wait_for "$out/$name-client.out" '"watching"' 40 ;;
    nfxd)
      "$NFXD" key new "$dir/fetcher.key" > /dev/null
      mkdir -p "$dir/client-store"
      local extra=()
      [ "$relay" = none ] || extra=(--iroh-relay "$relay")
      [ -n "$CA_HEX" ] && [ "$relay" != none ] && extra+=(--iroh-relay-ca "$work/tls/ca.crt")
      start "$name-client" sdhb "$NFXD" run \
        --key "$dir/fetcher.key" --store "$dir/client-store" --state "$dir/client-state" \
        --relay "$NOSTR_URL" --fetch "$A" "${extra[@]}"
      wait_for "$out/$name-client.err" "$A: Fetching" 40 ;;
  esac
}

# server IMPL NAME DIR RELAY [--poison]: in $SERVER_NS (sdha unless a cell says otherwise); an
# nfxd server also gets the cell's $SERVER_ARGS.
server() {
  local impl=$1 name=$2 dir=$3 relay=$4 poison=${5:-}
  case $impl in
    helper)
      start "$name-server" "$SERVER_NS" "$NODE" "$HARNESS" serve --helper "$HELPER" --state "$dir/server" \
        --iroh-relay "$relay" --nostr "$NOSTR_URL" --package "$work/pkg" --a "$A" ${poison:+--poison} \
        ${CA_HEX:+--relay-ca "$CA_HEX"}
      wait_for "$out/$name-server.out" '"ready"|"ok": ?false' 60 ;;
    nfxd)
      "$NFXD" key new "$dir/seeder.key" > /dev/null
      cp -r "$work/pkg/store" "$dir/server-store"
      local extra=()
      [ "$relay" = none ] || extra=(--iroh-relay "$relay")
      [ -n "$CA_HEX" ] && [ "$relay" != none ] && extra+=(--iroh-relay-ca "$work/tls/ca.crt")
      start "$name-server" "$SERVER_NS" "$NFXD" run \
        --key "$dir/seeder.key" --store "$dir/server-store" --state "$dir/server-state" \
        --relay "$NOSTR_URL" --seed "$A" "${extra[@]}" "${SERVER_ARGS[@]}"
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
  local name="$cell-$cli-from-$srv${poison:+-poison}" dir t0 t1 res meter evidence sready cpid spid
  dir="$work/$name"
  mkdir -p "$dir"
  local mark=${#pids[@]} up=0
  nostr_up "$dir" || up=$?
  if [ "$up" -eq 1 ]; then
    record "$name" "$judged" "$expect" "$path" "$err" \
      "{\"ok\":false,\"error\":\"harness: no Nostr relay ($NOSTR_IMPL)\"}"
  elif [ "$up" -ne 0 ]; then
    # The relay is up and refused (or never answered) the manifest: for a stock relay, a finding.
    res=$(json 'import json,sys
try: why=open(sys.argv[1], errors="replace").read().strip()[-400:]
except OSError: why=""
print(json.dumps({"ok":False,"error":"manifest not published","publish_err":why}))' "$out/$name-publish.err")
    res=$(json 'import json,sys; d=json.loads(sys.argv[1]); d.update(json.loads(sys.argv[2])); print(json.dumps(d))' \
      "$res" "$(relay_evidence "$dir" "$name")")
    record "$name" "$judged" "$expect" "$path" "$err" "$res"
  elif ! meter_reset; then
    record "$name" "$judged" "$expect" "$path" "$err" '{"ok":false,"error":"harness: byte meter"}'
  elif ! client "$cli" "$name" "$dir" "$relay"; then
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
    evidence=$(relay_evidence "$dir" "$name" || echo "{}")
    res=$(json 'import json,sys
d=json.loads(sys.argv[1]); m=json.loads(sys.argv[2]); v=int(sys.argv[3])
d["server_ready"]=sys.argv[8]=="yes"
d["server_rss_kib"]=json.loads(sys.argv[9]); d["client_rss_kib"]=json.loads(sys.argv[10])
d.update(json.loads(sys.argv[11])); d["nostr"]=sys.argv[12]; d["server_ns"]=sys.argv[13]
d.update(m); d["wall_ms"]=(int(sys.argv[5])-int(sys.argv[4]))//1000000
dr,rl=m.get("direct_bytes",0),m.get("relayed_bytes",0)
d["path"]="direct" if dr>=0.9*v else ("relay" if rl>=0.9*v else ("mixed" if dr+rl>=0.9*v else "none"))
if d.get("ok") is True and d["wall_ms"]>0 and "mbit_s" not in d: d["mbit_s"]=round(v*8/(d["wall_ms"]/1000)/1e6,1)
d["server"],d["client"]=sys.argv[6],sys.argv[7]
print(json.dumps(d))' "$res" "$meter" "$VIDEO_BYTES" "$t0" "$t1" "$srv" "$cli" "$sready" \
      "$(session_rss "$spid")" "$(session_rss "$cpid")" "$evidence" "$NOSTR_IMPL" "$SERVER_NS")
    record "$name" "$judged" "$expect" "$path" "$err" "$res"
  fi
  # Stop this pairing's processes (relay, client, server), newest first.
  local i
  for (( i=${#pids[@]}-1; i>=mark; i-- )); do stop "${pids[$i]}"; unset "pids[$i]"; done
  pids=("${pids[@]}")
}

pairings() { # CELL JUDGED EXPECT PATH RELAY
  local srv cli
  for srv in $SERVERS; do
    for cli in nfxd helper; do
      pairing "$1" "$2" "$3" "$4" - "$srv" "$cli" "$5"
    done
  done
}
skips() { # CELL EXPECT PATH REASON: skip a cell's pairings (the servers in $SERVERS)
  local srv cli
  for srv in $SERVERS; do
    for cli in nfxd helper; do skip "$1-$cli-from-$srv" "$2" "$3" "$4"; done
  done
}

# Every check of the run as a table, from $OUT/nat.jsonl (the job summary prints the same).
table() {
  json 'import json,sys
rows=[("check","expect","got","path","direct B","relayed B","nostr B","verdict")]
for line in open(sys.argv[1]):
    d=json.loads(line)
    if "passed" not in d and not d.get("skipped"): continue
    exp=d["expect"]+("" if d.get("expect_path") in ("-","any",None) else " "+d["expect_path"])
    if d.get("skipped"):
        rows.append((d["check"],exp,"-","-","-","-","-","SKIP"))
        continue
    got="ok" if d.get("ok") is True else "fail: "+str(d.get("error",""))[:28]
    verdict="PASS" if d["passed"] else ("FAIL" if d["judged"] else "info")
    rows.append((d["check"],exp,got,str(d.get("path","-")),str(d.get("direct_bytes","-")),
                 str(d.get("relayed_bytes","-")),str(d.get("nostr_bytes","-")),verdict))
w=[max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
for r in rows: print("  ".join(c.ljust(w[i]) for i,c in enumerate(r)).rstrip())' "$out/nat.jsonl"
}

# --- the content: one clip, packaged once by nfx-package, published by one creator key ---------
cat > "$work/iroh-relay-http.toml" <<EOF
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
EVICT=12
pairings open-open yes ok direct "$IROH_URL"
EVICT=
pairing open-open yes fail - poisoned helper helper "$IROH_URL" --poison

topology consistent consistent
pairings consistent-consistent yes ok any "$IROH_URL"

topology symmetric symmetric
pairings symmetric-symmetric yes ok relay "$IROH_URL"
pairings symmetric-symmetric-norelay yes fail - none

topology consistent symmetric
pairings consistent-symmetric yes ok any "$IROH_URL"

# --- nfx #30's groundwork: Nostr-only cells (no iroh relay on either side) ----------------------
echo "nfxd under test: N1's --iroh-bind/--iroh-external $([ "$N1" = yes ] && echo present || echo absent)"
n1_missing="the nfxd under test has no --iroh-bind/--iroh-external (nfx N1, not at this NFX_SHA); bumping NFX_SHA to a commit with N1 turns this cell on"
T_OK=$TIMEOUT
# fwdseed_cells PREFIX FETCHER-NAT...: nfxd behind router A's port forward, bound to the forwarded
# port and advertising the router's address (N1's flags); skipped without them. nfxd only: the
# helper has no such flags.
fwdseed_cells() {
  local p=$1 b
  shift
  for b in "$@"; do
    if [ "$N1" = yes ]; then
      SERVER_ARGS=(--iroh-bind "$FWD_BIND" --iroh-external "$FWD_EXTERNAL")
      topology forward "$b"
      pairings "${p}fwdseed-$b-norelay" yes ok direct none
      SERVER_ARGS=()
    else
      skips "${p}fwdseed-$b-norelay" ok direct "$n1_missing"
    fi
  done
}

# On nfxd's scoped relay.
topology open open
pairings open-open-norelay yes ok direct none
TIMEOUT=$FAIL_TIMEOUT
topology consistent consistent
pairings consistent-consistent-norelay yes fail - none
topology consistent symmetric
pairings consistent-symmetric-norelay yes fail - none
TIMEOUT=$T_OK
SERVER_NS=sdps
topology consistent consistent
pairings pubseed-consistent-norelay yes ok direct none
topology consistent symmetric
pairings pubseed-symmetric-norelay yes ok direct none
SERVER_NS=sdha
SERVERS=nfxd
TIMEOUT=$FAIL_TIMEOUT
topology forward symmetric
pairings fwdseed-symmetric-noflags yes fail - none
TIMEOUT=$T_OK
fwdseed_cells "" consistent symmetric
SERVERS="nfxd helper"

# The standing goal, compatible with Nostr relays: the same discovery through a stock relay.
NOSTR_IMPL=strfry
topology open open
pairings stock-open-open-norelay yes ok direct none
SERVER_NS=sdps
topology consistent symmetric
pairings stock-pubseed-symmetric-norelay yes ok direct none
SERVER_NS=sdha
SERVERS=nfxd
fwdseed_cells stock- symmetric
SERVERS="nfxd helper"
NOSTR_IMPL=nfxd

# Unknown 1: holepunching with the relay's QUIC address discovery (TLS relay, CI CA).
tls_setup
RELAY_KIND=tls
topology consistent consistent
pairings consistent-consistent-qad yes ok direct "$IROH_TLS_URL"
topology symmetric symmetric
pairings symmetric-symmetric-tls yes ok relay "$IROH_TLS_URL"
topology consistent symmetric
pairings consistent-symmetric-qad yes ok any "$IROH_TLS_URL"

echo
table
exit "$failed"
