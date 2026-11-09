//! Which ICE candidates the helper uses and shows (ADR 0023).
//!
//! **Remote:** a full ICE agent sends connectivity checks to every candidate the other side
//! lists. A hostile offer could list loopback, LAN or cloud-metadata addresses and turn the
//! helper into a prober of the user's network (nfx's M1 audit, finding M3, about the same
//! library). So the helper keeps only UDP candidates at global unicast addresses, at most
//! [`MAX_REMOTE`] of them, never its own public address, and drops hostnames (a browser's mDNS
//! `*.local` names) before str0m sees the SDP. A line is read exactly as str0m reads it: fields
//! separated by single spaces, and a line with any other whitespace or control character is
//! dropped, so a field cannot hide an address from this filter that str0m would then use. The
//! engine also refuses to send to any address this filter would refuse (an egress check), so a
//! candidate str0m learns another way is held to the same rule. A browser behind a NAT is still
//! reached: its server-reflexive candidate is global, and a check it sends teaches str0m its
//! peer-reflexive address.
//!
//! **Local:** str0m only answers checks that arrive at a host candidate, so the helper keeps its
//! socket's address as one, but leaves a private one out of the SDP it hands out: the remote
//! learns the public mapping (server-reflexive) and never the LAN address, as browsers hide
//! theirs behind mDNS names. A kept candidate's `raddr` is zeroed and its foundation renumbered:
//! str0m derives a foundation from the base address, and a hash of a private address is that
//! address to anyone who hashes the few million private ones.
//!
//! `allow_private` (tests and same-LAN runs only) lifts these rules for everything except
//! unspecified, multicast and broadcast addresses and port 0.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Remote candidates kept from one SDP.
pub const MAX_REMOTE: usize = 16;

fn v4_global(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0                                   // "this network"
        || a == 10                             // private
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT, tailnets)
        || a == 127                            // loopback
        || (a == 169 && b == 254)              // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b)) // private
        || (a == 192 && b == 0 && c == 0)      // IETF protocol assignments
        || (a == 192 && b == 0 && c == 2)      // documentation
        || (a == 192 && b == 168)              // private
        || (a == 198 && (b == 18 || b == 19))  // benchmarking
        || (a == 198 && b == 51 && c == 100)   // documentation
        || (a == 203 && b == 0 && c == 113)    // documentation
        || a >= 224) // multicast, reserved, broadcast
}

fn v6_global(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // Global unicast is 2000::/3; within it, leave out the documentation prefixes.
    (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && s[1] == 0x0db8) && (s[0] & 0xfff0) != 0x3ff0
}

/// Whether the helper may send checks to, or show, `ip`. Global unicast still includes the
/// user's own public address (see [`may_check`]) and, over IPv6, hosts in the same /64.
#[must_use]
pub fn allowed(ip: IpAddr, allow_private: bool) -> bool {
    match ip {
        IpAddr::V4(v4) if allow_private => {
            !v4.is_unspecified() && !v4.is_multicast() && !v4.is_broadcast()
        }
        IpAddr::V6(v6) if allow_private => !v6.is_unspecified() && !v6.is_multicast(),
        IpAddr::V4(v4) => v4_global(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4_global(v4),
            None => v6_global(v6),
        },
    }
}

/// Whether the helper may send to `ip:port`: [`allowed`], a port, and not the user's own public
/// address `own` (a check there would land on the user's router, at a forwarded port).
#[must_use]
pub fn may_check(ip: IpAddr, port: u16, allow_private: bool, own: Option<IpAddr>) -> bool {
    port != 0 && allowed(ip, allow_private) && (allow_private || Some(ip) != own)
}

/// The fields of an `a=candidate:` line split as str0m splits them (single spaces), if the
/// line holds nothing but printable ASCII and spaces and is a UDP candidate at an IP address:
/// the fields, the address and the port.
fn fields(line: &str) -> Option<(Vec<&str>, IpAddr, u16)> {
    let rest = line.strip_prefix("a=candidate:")?;
    if !rest.bytes().all(|c| (0x20..=0x7e).contains(&c)) {
        return None;
    }
    let f: Vec<&str> = rest.split(' ').collect();
    // foundation component transport priority address port "typ" type ...
    if f.len() < 8 || f.iter().any(|w| w.is_empty()) || f[6] != "typ" {
        return None;
    }
    if !f[2].eq_ignore_ascii_case("udp") {
        return None;
    }
    let ip: IpAddr = f[4].parse().ok()?;
    let port: u16 = f[5].parse().ok()?;
    Some((f, ip, port))
}

/// A remote offer or answer with only the candidates the helper may check ([`may_check`]), at
/// most [`MAX_REMOTE`]; every other line is kept as it was. Returns the SDP and how many
/// candidates it kept.
#[must_use]
pub fn remote(sdp: &str, allow_private: bool, own: Option<IpAddr>) -> (String, usize) {
    let mut out = String::with_capacity(sdp.len());
    let mut kept = 0;
    for line in sdp.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare.starts_with("a=candidate:") {
            let ok = kept < MAX_REMOTE
                && fields(bare)
                    .is_some_and(|(_, ip, port)| may_check(ip, port, allow_private, own));
            if !ok {
                continue;
            }
            kept += 1;
        }
        out.push_str(line);
    }
    (out, kept)
}

/// The helper's own offer or answer without what it must not show: a candidate at a private
/// address, a private base address in a kept one's `raddr`, or a foundation derived from one
/// (unless `allow_private`). Kept candidates are renumbered `1`, `2`, ... Returns the SDP and how
/// many candidates it shows.
#[must_use]
pub fn local(sdp: &str, allow_private: bool) -> (String, usize) {
    let mut out = String::with_capacity(sdp.len());
    let mut kept = 0usize;
    for line in sdp.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if !bare.starts_with("a=candidate:") {
            out.push_str(line);
            continue;
        }
        let foundation = (kept + 1).to_string();
        let Some((mut f, ip, port)) = fields(bare) else {
            continue;
        };
        if port == 0 || !allowed(ip, allow_private) {
            continue;
        }
        kept += 1;
        if !allow_private {
            f[0] = &foundation;
            if let Some(i) = f.iter().position(|w| *w == "raddr")
                && i + 3 < f.len()
                && f[i + 2] == "rport"
            {
                let shown = f[i + 1]
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| allowed(ip, false));
                if !shown {
                    f[i + 1] = "0.0.0.0";
                    f[i + 3] = "0";
                }
            }
        }
        out.push_str("a=candidate:");
        out.push_str(&f.join(" "));
        out.push_str(&line[bare.len()..]);
    }
    (out, kept)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn only_global_unicast_passes() {
        for a in [
            "8.8.8.8",
            "185.147.157.180",
            "2a01:4f8::1",
            "::ffff:8.8.8.8",
        ] {
            assert!(allowed(a.parse().unwrap(), false), "{a}");
        }
        for a in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.3",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.5.4",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.10",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.5",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "ff02::1",
            "2001:db8::1",
            "3fff::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(!allowed(a.parse().unwrap(), false), "{a}");
        }
        assert!(allowed("127.0.0.1".parse().unwrap(), true));
        assert!(allowed("10.0.0.1".parse().unwrap(), true));
        assert!(!allowed("0.0.0.0".parse().unwrap(), true));
        assert!(!allowed("255.255.255.255".parse().unwrap(), true));
        assert!(!allowed("ff02::1".parse().unwrap(), true));
    }

    const OFFER: &str = "v=0\r\n\
o=- 1 2 IN IP4 127.0.0.1\r\n\
a=group:BUNDLE 0\r\n\
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n\
a=candidate:1 1 udp 2122260223 4d2a1c3e-1111-2222-3333-444455556666.local 50028 typ host generation 0\r\n\
a=candidate:2 1 udp 1686052607 8.8.4.4 31267 typ srflx raddr 0.0.0.0 rport 0 generation 0\r\n\
a=candidate:3 1 udp 1686052607 169.254.169.254 80 typ srflx raddr 0.0.0.0 rport 0\r\n\
a=candidate:4 1 tcp 1518280447 8.8.4.4 9 typ host tcptype active\r\n\
a=candidate:5 1 udp 1686052607 8.8.4.4 0 typ srflx\r\n\
a=candidate:6 1 UDP 1686052607 192.168.1.20 5000 typ host\r\n\
a=end-of-candidates\r\n";

    #[test]
    fn remote_candidates_are_filtered() {
        let (sdp, kept) = remote(OFFER, false, None);
        assert_eq!(kept, 1);
        assert!(sdp.contains("8.8.4.4 31267 typ srflx"));
        assert!(!sdp.contains(".local"));
        assert!(!sdp.contains("169.254.169.254"));
        assert!(!sdp.contains("tcptype"));
        assert!(!sdp.contains("192.168.1.20"));
        // Every other line survives, line endings included.
        assert!(sdp.contains("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"));
        assert!(sdp.ends_with("a=end-of-candidates\r\n"));
        // With allow_private the LAN host passes too (UDP is case-insensitive).
        let (sdp, kept) = remote(OFFER, true, None);
        assert_eq!(kept, 3);
        assert!(sdp.contains("192.168.1.20 5000"));
        // The user's own public address is never a target.
        let own = Some("8.8.4.4".parse().unwrap());
        assert_eq!(remote(OFFER, false, own).1, 0);
    }

    #[test]
    fn a_candidate_cannot_hide_its_address() {
        // str0m splits on single spaces and takes a tab as part of a field: a foundation of
        // tabs would show this filter a decoy where str0m reads 192.168.1.1:5000.
        let tabs = "a=candidate:x\tx\tudp\tx\t8.8.8.8 1 udp 1 192.168.1.1 5000 typ host\r\n";
        assert_eq!(remote(tabs, false, None).1, 0);
        // Double spaces, a trailing space and other control characters are refused too.
        for line in [
            "a=candidate:1 1 udp 1  8.8.8.8 5000 typ host\r\n",
            "a=candidate:1 1 udp 1 8.8.8.8 5000 typ host \r\n",
            "a=candidate:1 1 udp 1 8.8.8.8 5000 typ\x0bhost\r\n",
            "a=candidate:1 1 udp 1 8.8.8.8 5000 host\r\n",
        ] {
            assert_eq!(remote(line, false, None).1, 0, "{line:?}");
        }
        assert_eq!(
            remote(
                "a=candidate:1 1 udp 1 8.8.8.8 5000 typ host\r\n",
                false,
                None
            )
            .1,
            1
        );
    }

    #[test]
    fn remote_candidates_are_capped() {
        let mut sdp = String::from("v=0\r\n");
        for i in 0..40 {
            sdp.push_str(&format!(
                "a=candidate:{i} 1 udp 1 8.8.8.{i} 4000 typ srflx\r\n"
            ));
        }
        assert_eq!(remote(&sdp, false, None).1, MAX_REMOTE);
    }

    #[test]
    fn a_private_host_is_not_shown() {
        // str0m's foundation is a hash of the base address: renumbered, as the raddr is zeroed.
        let ours = "v=0\r\n\
a=candidate:2130706431 1 udp 2130706431 192.168.1.20 40000 typ host\r\n\
a=candidate:9876543210 1 udp 1694498815 185.147.157.180 61000 typ srflx raddr 192.168.1.20 rport 40000\r\n";
        let (sdp, kept) = local(ours, false);
        assert_eq!(kept, 1);
        assert!(!sdp.contains("192.168.1.20"));
        assert!(!sdp.contains("9876543210"));
        assert!(sdp.contains(
            "a=candidate:1 1 udp 1694498815 185.147.157.180 61000 typ srflx raddr 0.0.0.0 rport 0\r\n"
        ));
        let (sdp, kept) = local(ours, true);
        assert_eq!(kept, 2);
        assert!(sdp.contains("raddr 192.168.1.20 rport 40000"));
    }
}
