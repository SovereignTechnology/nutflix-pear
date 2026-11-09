//! Which ICE candidates the helper uses and shows (ADR 0023).
//!
//! **Remote:** a full ICE agent sends connectivity checks to every candidate the other side
//! lists. A hostile offer could list loopback, LAN or cloud-metadata addresses and turn the
//! helper into a prober of the user's network (nfx's M1 audit, finding M3, about the same
//! library). So the helper keeps only UDP candidates at global unicast addresses, at most
//! [`MAX_REMOTE`] of them, and drops hostnames (a browser's mDNS `*.local` names) before str0m
//! sees the SDP. A browser behind a NAT is still reached: its server-reflexive candidate is
//! global, and a check it sends teaches str0m its peer-reflexive address.
//!
//! **Local:** str0m only answers checks that arrive at a host candidate, so the helper keeps its
//! socket's address as one, but leaves a private one out of the SDP it hands out: the remote
//! learns the public mapping (server-reflexive) and never the LAN address, as browsers hide
//! theirs behind mDNS names.
//!
//! `allow_private` (tests and same-LAN runs only) lifts both rules for everything except
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

/// Whether the helper may send checks to, or show, `ip`.
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

/// The address and port of an `a=candidate:` line, if it is a UDP candidate at an IP address.
fn udp_addr(line: &str) -> Option<(IpAddr, u16)> {
    let rest = line.strip_prefix("a=candidate:")?;
    let mut f = rest.split_ascii_whitespace();
    let (_foundation, _component) = (f.next()?, f.next()?);
    if !f.next()?.eq_ignore_ascii_case("udp") {
        return None;
    }
    let _priority = f.next()?;
    let ip: IpAddr = f.next()?.parse().ok()?;
    let port: u16 = f.next()?.parse().ok()?;
    Some((ip, port))
}

/// Rewrite `sdp`, keeping only the candidate lines `keep` accepts (and at most `max`); every
/// other line is kept as it was. With `scrub`, a kept line's related address (`raddr`, the base
/// of a server-reflexive candidate) is replaced by `0.0.0.0 rport 0` unless `keep` would show
/// it, as RFC 8839 §5.1 allows. Returns the SDP and how many candidates it kept.
fn rewrite(
    sdp: &str,
    max: usize,
    scrub: bool,
    keep: impl Fn(IpAddr, u16) -> bool,
) -> (String, usize) {
    let mut out = String::with_capacity(sdp.len());
    let mut kept = 0;
    for line in sdp.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\r', '\n']);
        if bare.starts_with("a=candidate:") {
            let ok = kept < max && udp_addr(bare).is_some_and(|(ip, port)| keep(ip, port));
            if !ok {
                continue;
            }
            kept += 1;
            if scrub {
                out.push_str(&scrubbed(bare, &keep));
                out.push_str(&line[bare.len()..]);
                continue;
            }
        }
        out.push_str(line);
    }
    (out, kept)
}

/// `line` with its `raddr <ip> rport <port>` pair zeroed unless `keep` accepts it.
fn scrubbed(line: &str, keep: &impl Fn(IpAddr, u16) -> bool) -> String {
    let words: Vec<&str> = line.split(' ').collect();
    let mut out: Vec<&str> = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        if words[i] == "raddr" && i + 3 < words.len() && words[i + 2] == "rport" {
            let shown = words[i + 1]
                .parse::<IpAddr>()
                .ok()
                .zip(words[i + 3].parse::<u16>().ok())
                .is_some_and(|(ip, port)| keep(ip, port));
            if shown {
                out.extend_from_slice(&words[i..i + 4]);
            } else {
                out.extend_from_slice(&["raddr", "0.0.0.0", "rport", "0"]);
            }
            i += 4;
            continue;
        }
        out.push(words[i]);
        i += 1;
    }
    out.join(" ")
}

/// A remote offer or answer with only the candidates the helper may check: global unicast UDP
/// (any unicast with `allow_private`), port not 0, at most [`MAX_REMOTE`].
#[must_use]
pub fn remote(sdp: &str, allow_private: bool) -> (String, usize) {
    rewrite(sdp, MAX_REMOTE, false, |ip, port| {
        port != 0 && allowed(ip, allow_private)
    })
}

/// The helper's own offer or answer without what it must not show: a candidate at a private
/// address, or a private base address in a kept one's `raddr` (unless `allow_private`).
#[must_use]
pub fn local(sdp: &str, allow_private: bool) -> (String, usize) {
    rewrite(sdp, usize::MAX, true, |ip, port| {
        port != 0 && allowed(ip, allow_private)
    })
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
        let (sdp, kept) = remote(OFFER, false);
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
        let (sdp, kept) = remote(OFFER, true);
        assert_eq!(kept, 3);
        assert!(sdp.contains("192.168.1.20 5000"));
    }

    #[test]
    fn remote_candidates_are_capped() {
        let mut sdp = String::from("v=0\r\n");
        for i in 0..40 {
            sdp.push_str(&format!(
                "a=candidate:{i} 1 udp 1 8.8.8.{i} 4000 typ srflx\r\n"
            ));
        }
        assert_eq!(remote(&sdp, false).1, MAX_REMOTE);
    }

    #[test]
    fn a_private_host_is_not_shown() {
        let ours = "v=0\r\n\
a=candidate:a 1 udp 2130706431 192.168.1.20 40000 typ host\r\n\
a=candidate:b 1 udp 1694498815 185.147.157.180 61000 typ srflx raddr 192.168.1.20 rport 40000\r\n";
        let (sdp, kept) = local(ours, false);
        assert_eq!(kept, 1);
        assert!(!sdp.contains("192.168.1.20"));
        assert!(sdp.contains(
            "a=candidate:b 1 udp 1694498815 185.147.157.180 61000 typ srflx raddr 0.0.0.0 rport 0\r\n"
        ));
        let (sdp, kept) = local(ours, true);
        assert_eq!(kept, 2);
        assert!(sdp.contains("raddr 192.168.1.20 rport 40000"));
    }
}
