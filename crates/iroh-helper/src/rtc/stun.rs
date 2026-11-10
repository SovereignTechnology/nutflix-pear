//! A STUN Binding client (RFC 8489 §6, request and success response only): how the helper
//! learns the public address its NAT gives its WebRTC socket, so a browser behind another NAT
//! has an address to send to. Browsers do not trickle candidates, so this runs before an answer
//! or offer is written (ADR 0023). It sends from the WebRTC socket itself: a mapping learned from
//! another socket would be a different mapping.
//!
//! No authentication, no FINGERPRINT, no retransmission schedule: one request per server per
//! round, a new round when the last has gone unanswered. Responses are matched to requests by
//! transaction id before anything reaches str0m, whose own ICE checks are STUN too.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const MAGIC: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const HEADER: usize = 20;

pub type TxId = [u8; 12];

/// A Binding request with transaction id `tx`: a bare 20-byte header.
#[must_use]
pub fn request(tx: &TxId) -> [u8; HEADER] {
    let mut m = [0u8; HEADER];
    m[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Length 0: no attributes.
    m[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    m[8..20].copy_from_slice(tx);
    m
}

/// The transaction id of a Binding success response, if `m` is one; anything else (ICE
/// traffic, DTLS, a malformed packet) is `None`.
#[must_use]
pub fn success_tx(m: &[u8]) -> Option<TxId> {
    if m.len() < HEADER
        || u16::from_be_bytes([m[0], m[1]]) != BINDING_SUCCESS
        || u32::from_be_bytes([m[4], m[5], m[6], m[7]]) != MAGIC
    {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([m[2], m[3]]));
    if len % 4 != 0 || HEADER + len != m.len() {
        return None;
    }
    m[8..20].try_into().ok()
}

/// The mapped address in a Binding success response `m` for transaction `tx`.
/// XOR-MAPPED-ADDRESS wins over MAPPED-ADDRESS (RFC 8489 §14.1, §14.2).
#[must_use]
pub fn mapped(m: &[u8], tx: &TxId) -> Option<SocketAddr> {
    if success_tx(m)? != *tx {
        return None;
    }
    let mut at = HEADER;
    let mut plain = None;
    while at + 4 <= m.len() {
        let kind = u16::from_be_bytes([m[at], m[at + 1]]);
        let len = usize::from(u16::from_be_bytes([m[at + 2], m[at + 3]]));
        let value = m.get(at + 4..at + 4 + len)?;
        match kind {
            XOR_MAPPED_ADDRESS => return address(value, Some(tx)),
            MAPPED_ADDRESS => plain = plain.or_else(|| address(value, None)),
            _ => {}
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    plain
}

/// An address attribute's value: `0x00, family, port, address`, XORed when `tx` is given.
fn address(v: &[u8], tx: Option<&TxId>) -> Option<SocketAddr> {
    let (head, rest) = v.split_first_chunk::<2>()?;
    let family = head[1];
    let (&port, ip) = rest.split_first_chunk::<2>()?;
    let mut port = u16::from_be_bytes(port);
    let magic = MAGIC.to_be_bytes();
    if tx.is_some() {
        port ^= u16::from_be_bytes([magic[0], magic[1]]);
    }
    let ip = match (family, ip.len()) {
        (0x01, 4) => {
            let mut b: [u8; 4] = ip.try_into().ok()?;
            if tx.is_some() {
                b.iter_mut().zip(magic).for_each(|(x, k)| *x ^= k);
            }
            IpAddr::V4(Ipv4Addr::from(b))
        }
        (0x02, 16) => {
            let mut b: [u8; 16] = ip.try_into().ok()?;
            if let Some(tx) = tx {
                let key = magic.iter().chain(tx.iter());
                b.iter_mut().zip(key).for_each(|(x, k)| *x ^= k);
            }
            IpAddr::V6(Ipv6Addr::from(b))
        }
        _ => return None,
    };
    let addr = SocketAddr::new(ip, port);
    (port != 0 && !ip.is_unspecified() && !ip.is_multicast()).then_some(addr)
}

/// A fresh transaction id.
pub fn tx() -> Option<TxId> {
    let mut t = [0u8; 12];
    getrandom::fill(&mut t).ok()?;
    Some(t)
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    /// A Binding success response for `tx` carrying `addr` as XOR-MAPPED-ADDRESS (and, when
    /// `plain` is given, a MAPPED-ADDRESS before it).
    pub(crate) fn response(tx: &TxId, addr: SocketAddr, plain: Option<SocketAddr>) -> Vec<u8> {
        let magic = MAGIC.to_be_bytes();
        let mut attrs = Vec::new();
        let mut attr = |kind: u16, a: SocketAddr, xor: bool| {
            let mut v = vec![0u8];
            let mut port = a.port();
            if xor {
                port ^= u16::from_be_bytes([magic[0], magic[1]]);
            }
            match a.ip() {
                IpAddr::V4(ip) => {
                    v.push(1);
                    v.extend_from_slice(&port.to_be_bytes());
                    let mut b = ip.octets();
                    if xor {
                        b.iter_mut().zip(magic).for_each(|(x, k)| *x ^= k);
                    }
                    v.extend_from_slice(&b);
                }
                IpAddr::V6(ip) => {
                    v.push(2);
                    v.extend_from_slice(&port.to_be_bytes());
                    let mut b = ip.octets();
                    if xor {
                        let key = magic.iter().chain(tx.iter());
                        b.iter_mut().zip(key).for_each(|(x, k)| *x ^= k);
                    }
                    v.extend_from_slice(&b);
                }
            }
            attrs.extend_from_slice(&kind.to_be_bytes());
            attrs.extend_from_slice(&(v.len() as u16).to_be_bytes());
            attrs.extend_from_slice(&v);
        };
        if let Some(p) = plain {
            attr(MAPPED_ADDRESS, p, false);
        }
        attr(XOR_MAPPED_ADDRESS, addr, true);
        let mut m = Vec::new();
        m.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        m.extend_from_slice(&(attrs.len() as u16).to_be_bytes());
        m.extend_from_slice(&magic);
        m.extend_from_slice(tx);
        m.extend_from_slice(&attrs);
        m
    }

    #[test]
    fn a_request_is_a_bare_header() {
        let tx = [7u8; 12];
        let r = request(&tx);
        assert_eq!(&r[0..4], &[0, 1, 0, 0]);
        assert_eq!(&r[4..8], &[0x21, 0x12, 0xa4, 0x42]);
        assert_eq!(&r[8..], &tx);
    }

    #[test]
    fn xor_mapped_addresses_decode() {
        let tx = [3u8; 12];
        for a in ["203.0.113.9:40000", "[2001:db8::5]:3478"] {
            let a: SocketAddr = a.parse().unwrap();
            assert_eq!(mapped(&response(&tx, a, None), &tx), Some(a));
        }
        // XOR wins over a plain MAPPED-ADDRESS listed first.
        let x: SocketAddr = "198.51.100.1:1000".parse().unwrap();
        let p: SocketAddr = "192.0.2.1:2000".parse().unwrap();
        assert_eq!(mapped(&response(&tx, x, Some(p)), &tx), Some(x));
    }

    #[test]
    fn other_packets_are_not_ours() {
        let tx = [3u8; 12];
        let a: SocketAddr = "203.0.113.9:40000".parse().unwrap();
        let m = response(&tx, a, None);
        // Another transaction.
        assert_eq!(mapped(&m, &[4u8; 12]), None);
        // A request, not a response.
        assert_eq!(success_tx(&request(&tx)), None);
        // A length that disagrees with the packet.
        let mut bad = m.clone();
        bad.push(0);
        assert_eq!(success_tx(&bad), None);
        // A truncated attribute.
        let mut cut = m[..m.len() - 2].to_vec();
        let len = (cut.len() - HEADER) as u16;
        cut[2..4].copy_from_slice(&len.to_be_bytes());
        assert_eq!(mapped(&cut, &tx), None);
        // DTLS and junk.
        assert_eq!(success_tx(&[22, 254, 253, 0, 0]), None);
    }
}
