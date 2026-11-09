#!/usr/bin/env bash
# The two-host run (.github/workflows/nfx-exit-two-host.yml): how the bytes this runner RECEIVES
# split between the iroh relays and direct paths. Neither the helper nor nfxd reports the path,
# so it is counted here, as the NAT matrix counts it on its router (spikes/iroh/nat/run.sh):
#
#   relayed  TCP from an iroh relay's address, source port 443 (the relay's HTTPS)
#   direct   UDP from anywhere else, DNS replies excluded (QUIC holepunched or direct)
#
# Loopback (the worker, its helper, the range server, nfxd's origin) is not counted. On the pear
# runner what arrives is mostly A (it fetches A, serves B); on the nfx runner mostly B. A rough
# split, not an exact one: small control traffic lands in both.
#
# A Nostr-only run (NFX_NOSTR_ONLY=true) has no iroh relay: NFX_IROH_RELAYS must then be empty,
# the relay sets stay empty, and relayed stays 0.
#
#   sudo NFX_IROH_RELAYS="https://h1/ https://h2/" meter.sh start
#   sudo NFX_NOSTR_ONLY=true NFX_IROH_RELAYS= meter.sh start
#   sudo meter.sh read > meter.json
set -euo pipefail
set -f # the relay list is split on spaces, never globbed
case ${1:?start or read} in
  start)
    v4=()
    v6=()
    relays=${NFX_IROH_RELAYS:-}
    if [ "${NFX_NOSTR_ONLY:-false}" = true ]; then
      [ -z "${relays//[[:space:]]/}" ] || { echo "meter: a Nostr-only run takes no iroh relay" >&2; exit 2; }
    else
      [ -n "${relays//[[:space:]]/}" ] || { echo "meter: no iroh relay given" >&2; exit 2; }
    fi
    for u in $relays; do
      host=${u#https://}
      host=${host%%/*}
      host=${host%%:*}
      [[ $host =~ ^[a-z0-9_.-]{1,253}$ ]] || { echo "meter: not a relay host: ${host:0:80}" >&2; exit 2; }
      while read -r ip; do
        if [[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then v4+=("$ip")
        elif [[ $ip =~ ^[0-9a-f:]{2,39}$ ]]; then v6+=("$ip"); fi
      done < <(getent ahosts "$host" | awk '{print $1}' | sort -u)
    done
    [ -z "${relays//[[:space:]]/}" ] || [ ${#v4[@]} -gt 0 ] || [ ${#v6[@]} -gt 0 ] ||
      { echo "meter: no relay address resolved" >&2; exit 2; }
    join() { local IFS=,; echo "$*"; }
    nft delete table inet nfxtwo 2>/dev/null || true
    {
      echo 'table inet nfxtwo {'
      echo '  set relay4 { type ipv4_addr; }'
      echo '  set relay6 { type ipv6_addr; }'
      echo '  counter relayed_bytes {}'
      echo '  counter direct_bytes {}'
      echo '  chain count_in {'
      echo '    type filter hook input priority filter - 10; policy accept;'
      echo '    iifname "lo" return'
      echo '    ip saddr @relay4 tcp sport 443 counter name relayed_bytes'
      echo '    ip6 saddr @relay6 tcp sport 443 counter name relayed_bytes'
      echo '    meta nfproto ipv4 ip saddr != @relay4 udp sport != 53 counter name direct_bytes'
      echo '    meta nfproto ipv6 ip6 saddr != @relay6 udp sport != 53 counter name direct_bytes'
      echo '  }'
      echo '}'
    } | nft -f -
    [ ${#v4[@]} -eq 0 ] || nft add element inet nfxtwo relay4 "{ $(join "${v4[@]}") }"
    [ ${#v6[@]} -eq 0 ] || nft add element inet nfxtwo relay6 "{ $(join "${v6[@]}") }"
    echo "meter: counting; relays v4=${#v4[@]} v6=${#v6[@]}"
    ;;
  read)
    nft -j list counters table inet nfxtwo | python3 -c '
import json, sys
c = {}
for o in json.load(sys.stdin)["nftables"]:
    k = o.get("counter")
    if k: c[k["name"]] = k.get("bytes", 0)
print(json.dumps({"relayed_bytes": c.get("relayed_bytes", 0), "direct_bytes": c.get("direct_bytes", 0)}))'
    ;;
  *) echo "usage: meter.sh start|read" >&2; exit 2 ;;
esac
