//! The iroh side: one endpoint serving iroh-blobs (NFX-06 §2), configured as nfx's node is
//! (nfx ADR 0103 §2): `presets::Minimal` (no n0 discovery), the network's own relays only.
//!
//! Nothing here knows NFX. It imports files, forms HashSeqs from hashes it is given, and fetches
//! blobs capped at the size it is given. Which files, in which order, and whether the bytes are
//! the right ones (sha256 against the hash list) are the worker's decisions.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use iroh::endpoint::{Connection, presets};
use iroh::protocol::Router;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayMap, RelayMode, RelayUrl, SecretKey, TransportAddr,
};
use iroh_blobs::api::Store;
use iroh_blobs::api::blobs::{AddBytesOptions, AddPathOptions, ImportMode};
use iroh_blobs::api::proto::BlobStatus;
use iroh_blobs::hashseq::HashSeq;
use iroh_blobs::protocol::{ChunkRanges, ChunkRangesExt as _, GetRequest};
use iroh_blobs::store::GcConfig;
use iroh_blobs::ticket::BlobTicket;
use iroh_blobs::{BlobFormat, BlobsProtocol, Hash, HashAndFormat};

use crate::rtc::candidates;

/// How long `init` waits for the home relay before answering (nfxd waits as long).
pub const ONLINE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound for dialling a peer (nfx-node's `CONNECT_TIMEOUT`).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Upper bound for one blob (nfx-node's `MEMBER_TIMEOUT`): a peer that stalls costs this.
pub const GET_TIMEOUT: Duration = Duration::from_secs(30);
/// How often untagged blobs are deleted: a fetched blob is handed to the worker and left
/// untagged, so it is evicted within this, not kept as a second copy.
pub const GC_INTERVAL: Duration = Duration::from_secs(10);
/// BLAKE3 chunk size in iroh-blobs.
const CHUNK: u64 = 1024;

pub struct Node {
    router: Router,
    store: Store,
    relays: Vec<RelayUrl>,
    relay_only: bool,
    /// `init`'s `local_addrs`: non-global direct addresses are handed out too.
    local_addrs: bool,
    blobs_dir: PathBuf,
}

/// `addr` with its relays and only its global direct addresses, by the rule the WebRTC side
/// shows its own candidates by ([`candidates::allowed`]): LAN, loopback, link-local, CGNAT and
/// documentation addresses, port 0, and any transport this build does not know are dropped.
/// A peer still reaches a seeder behind a NAT through its relay, and iroh's hole punching
/// learns the rest once connected; what is handed out (a beacon, a ticket) names no host on
/// the user's network.
#[must_use]
pub fn only_global(addr: EndpointAddr) -> EndpointAddr {
    let kept = addr.addrs.into_iter().filter(|t| match t {
        TransportAddr::Relay(_) => true,
        TransportAddr::Ip(ip) => ip.port() != 0 && candidates::allowed(ip.ip(), false),
        _ => false,
    });
    EndpointAddr::from_parts(addr.id, kept)
}

/// Where this node can be reached, as a beacon's iroh endpoint carries it (NFX-03 §4).
pub struct Reach {
    pub node: String,
    pub relay: String,
    pub addrs: Vec<String>,
}

/// What a ticket says, decoded and nothing else: no network use, no trust.
pub struct TicketParts {
    pub node: String,
    pub hash: String,
    pub format: &'static str,
    pub relays: Vec<String>,
    pub addrs: Vec<String>,
}

pub fn hex_id(id: &EndpointId) -> String {
    hex::encode(id.as_bytes())
}

pub fn hex_hash(hash: &Hash) -> String {
    hex::encode(hash.as_bytes())
}

/// 64 lowercase hex → 32 bytes (the form every hash and id takes on this protocol).
fn lower_hex32(s: &str) -> Option<[u8; 32]> {
    if s.bytes().any(|c| c.is_ascii_uppercase()) {
        return None;
    }
    let mut b = [0u8; 32];
    hex::decode_to_slice(s, &mut b).ok()?;
    Some(b)
}

pub fn parse_hash(s: &str) -> Option<Hash> {
    lower_hex32(s).map(Hash::from_bytes)
}

pub fn parse_id(s: &str) -> Option<EndpointId> {
    EndpointId::from_bytes(&lower_hex32(s)?).ok()
}

fn format_name(format: BlobFormat) -> &'static str {
    if format == BlobFormat::HashSeq {
        "hash_seq"
    } else if format == BlobFormat::Raw {
        "raw"
    } else {
        "other"
    }
}

pub fn decode_ticket(s: &str) -> Result<TicketParts, String> {
    let t: BlobTicket = s.parse().map_err(|e| format!("not a ticket: {e}"))?;
    let addr = t.addr();
    Ok(TicketParts {
        node: hex_id(&addr.id),
        hash: hex_hash(&t.hash()),
        format: format_name(t.format()),
        relays: addr.relay_urls().map(ToString::to_string).collect(),
        addrs: addr.ip_addrs().map(ToString::to_string).collect(),
    })
}

/// Where a connection's data goes now (`conn-path`, pear #123): its selected path, as iroh
/// reports it. A fact about the user's own connection, read when asked; nothing is sent.
#[derive(Debug, PartialEq, Eq)]
pub struct PathReport {
    /// `direct` (an IP path), `relay`, `other` (a transport iroh adds later), or `none` (no path
    /// is selected: the connection is closing, or has not settled on one).
    pub kind: &'static str,
    /// The remote `ip:port` of a direct path.
    pub addr: Option<SocketAddr>,
    /// The relay's host, for a relayed path.
    pub relay: Option<String>,
    /// The path's round-trip estimate, in milliseconds.
    pub rtt_ms: Option<u64>,
}

impl PathReport {
    const NONE: Self = Self {
        kind: "none",
        addr: None,
        relay: None,
        rtt_ms: None,
    };
}

/// The selected path of `conn`. The caller holds `conn` (a clone of the open connection), which
/// keeps every path of the snapshot readable: iroh reads a path's statistics through it.
pub fn path_of(conn: &Connection) -> PathReport {
    let paths = conn.paths();
    let Some(p) = paths.iter().find(|p| p.is_selected()) else {
        return PathReport::NONE;
    };
    let rtt = u64::try_from(p.rtt().as_millis()).unwrap_or(u64::MAX);
    describe(p.remote_addr(), Some(rtt))
}

fn describe(addr: &TransportAddr, rtt_ms: Option<u64>) -> PathReport {
    match addr {
        TransportAddr::Ip(a) => PathReport {
            kind: "direct",
            addr: Some(*a),
            relay: None,
            rtt_ms,
        },
        TransportAddr::Relay(url) => PathReport {
            kind: "relay",
            addr: None,
            relay: url.host_str().map(str::to_owned),
            rtt_ms,
        },
        _ => PathReport {
            kind: "other",
            addr: None,
            relay: None,
            rtt_ms,
        },
    }
}

/// Why a `get` failed.
pub enum GetError {
    Timeout,
    /// The blob is larger than the cap, or did not complete.
    TooLarge,
    Transfer(String),
}

impl Node {
    pub async fn spawn(
        dir: &Path,
        secret: Option<[u8; 32]>,
        relays: Vec<RelayUrl>,
        relay_only: bool,
        portmapper: bool,
        local_addrs: bool,
        relay_cas: Vec<Vec<u8>>,
    ) -> Result<Self, String> {
        let mut builder = Endpoint::builder(presets::Minimal);
        builder = if relays.is_empty() {
            builder.relay_mode(RelayMode::Disabled)
        } else {
            builder.relay_mode(RelayMode::Custom(
                relays.iter().cloned().collect::<RelayMap>(),
            ))
        };
        if let Some(key) = secret {
            builder = builder.secret_key(SecretKey::from(key));
        }
        if relay_only {
            builder = builder.clear_ip_transports();
        }
        if !portmapper {
            builder = builder.portmapper_config(iroh::endpoint::PortmapperConfig::Disabled);
        }
        if !relay_cas.is_empty() {
            // Added to iroh's embedded roots, never in place of them; relay TLS only.
            let extra = relay_cas
                .into_iter()
                .map(rustls_pki_types::CertificateDer::from);
            builder =
                builder.ca_tls_config(iroh::tls::CaTlsConfig::default().with_extra_roots(extra));
        }
        let endpoint = builder.bind().await.map_err(|e| format!("bind: {e}"))?;
        let blobs_dir = dir.join("iroh-blobs");
        std::fs::create_dir_all(&blobs_dir).map_err(|e| format!("state dir: {e}"))?;
        let mut opts = iroh_blobs::store::fs::options::Options::new(&blobs_dir);
        opts.gc = Some(GcConfig {
            interval: GC_INTERVAL,
            add_protected: None,
        });
        let store: Store =
            iroh_blobs::store::fs::FsStore::load_with_opts(blobs_dir.join("blobs.db"), opts)
                .await
                .map_err(|e| format!("blob store: {e}"))?
                .into();
        let router = Router::builder(endpoint)
            .accept(iroh_blobs::ALPN, BlobsProtocol::new(&store, None))
            .spawn();
        let node = Self {
            router,
            store,
            relays,
            relay_only,
            local_addrs,
            blobs_dir,
        };
        if !node.relays.is_empty() {
            // Best effort, as nfxd: tickets carry the home relay once it is reached; direct
            // addresses work without it.
            let _ = tokio::time::timeout(ONLINE_TIMEOUT, node.endpoint().online()).await;
        }
        Ok(node)
    }

    fn endpoint(&self) -> &Endpoint {
        self.router.endpoint()
    }

    /// This node's address as it is handed out: [`only_global`] unless `local_addrs`.
    fn handed_out(&self) -> EndpointAddr {
        let addr = self.endpoint().addr();
        if self.local_addrs {
            addr
        } else {
            only_global(addr)
        }
    }

    pub fn reach(&self) -> Reach {
        let addr = self.handed_out();
        Reach {
            node: hex_id(&addr.id),
            relay: addr
                .relay_urls()
                .next()
                .map(ToString::to_string)
                .unwrap_or_default(),
            addrs: addr.ip_addrs().map(ToString::to_string).collect(),
        }
    }

    /// The address to dial: only direct IP addresses (none on a relay-only node) and this
    /// network's own relays. A relay named by anyone else is dropped (NFX-06 §2), so the
    /// worker cannot be talked into making this process contact a host of a peer's choosing.
    pub fn trusted(
        &self,
        id: EndpointId,
        relays: &[RelayUrl],
        addrs: &[SocketAddr],
    ) -> EndpointAddr {
        let ips = addrs
            .iter()
            .filter(|_| !self.relay_only)
            .map(|a| TransportAddr::Ip(*a));
        let ours = relays
            .iter()
            .filter(|u| self.relays.contains(u))
            .map(|u| TransportAddr::Relay(u.clone()));
        EndpointAddr::from_parts(id, ips.chain(ours))
    }

    pub async fn dial(&self, addr: EndpointAddr) -> Result<Connection, String> {
        if addr.addrs.is_empty() {
            return Err("no address this node may use".into());
        }
        tokio::time::timeout(
            CONNECT_TIMEOUT,
            self.endpoint().connect(addr, iroh_blobs::ALPN),
        )
        .await
        .map_err(|_| "connect timed out".to_owned())?
        .map_err(|e| e.to_string())
    }

    /// Import a file by reference (it is the worker's checked store file and never changes,
    /// as nfx-node's seed path does). The store may still copy it: `TryReference` is a hint.
    pub async fn import(&self, path: PathBuf) -> Result<(Hash, u64), String> {
        let tag = self
            .store
            .add_path_with_opts(AddPathOptions {
                path,
                format: BlobFormat::Raw,
                mode: ImportMode::TryReference,
            })
            .await
            .map_err(|e| e.to_string())?;
        match self
            .store
            .status(tag.hash)
            .await
            .map_err(|e| e.to_string())?
        {
            BlobStatus::Complete { size } => Ok((tag.hash, size)),
            _ => Err("import did not complete".into()),
        }
    }

    /// A HashSeq of `members` (each must be complete here), tagged `tag` so it and its members
    /// are kept, and a ticket for it naming this node.
    pub async fn seq(&self, members: &[Hash], tag: &str) -> Result<(Hash, BlobTicket), String> {
        for m in members {
            if !matches!(
                self.store.status(*m).await.map_err(|e| e.to_string())?,
                BlobStatus::Complete { .. }
            ) {
                return Err(format!("member {} is not stored here", hex_hash(m)));
            }
        }
        let seq: HashSeq = members.iter().copied().collect();
        let added = self
            .store
            .add_bytes_with_opts(AddBytesOptions {
                data: seq.into_inner(),
                format: BlobFormat::HashSeq,
            })
            .await
            .map_err(|e| e.to_string())?;
        self.store
            .tags()
            .set(tag, HashAndFormat::hash_seq(added.hash))
            .await
            .map_err(|e| e.to_string())?;
        let ticket = BlobTicket::new(self.handed_out(), added.hash, BlobFormat::HashSeq);
        Ok((added.hash, ticket))
    }

    pub async fn untag(&self, tag: &str) -> Result<u64, String> {
        self.store
            .tags()
            .delete(tag)
            .await
            .map_err(|e| e.to_string())
    }

    /// One blob, downloading at most `cap` bytes of it, as nfx-node's `fetch_member`: a blob
    /// larger than `cap` stays incomplete and is refused. A temp tag keeps it until it has
    /// been read; then it is untagged and collected.
    pub async fn get(&self, conn: &Connection, hash: Hash, cap: u64) -> Result<Vec<u8>, GetError> {
        let transfer = |e: &dyn std::fmt::Display| GetError::Transfer(e.to_string());
        let _hold = self
            .store
            .tags()
            .temp_tag(HashAndFormat::raw(hash))
            .await
            .map_err(|e| transfer(&e))?;
        let complete = |s: &BlobStatus| matches!(s, BlobStatus::Complete { size } if *size <= cap);
        let status = self.store.status(hash).await.map_err(|e| transfer(&e))?;
        if !complete(&status) {
            let chunks = cap.div_ceil(CHUNK).max(1);
            let request = GetRequest::blob_ranges(hash, ChunkRanges::chunks(..chunks));
            tokio::time::timeout(
                GET_TIMEOUT,
                self.store.remote().execute_get(conn.clone(), request),
            )
            .await
            .map_err(|_| GetError::Timeout)?
            .map_err(|e| transfer(&e))?;
        }
        let status = self.store.status(hash).await.map_err(|e| transfer(&e))?;
        if !complete(&status) {
            return Err(GetError::TooLarge);
        }
        let bytes = self.store.get_bytes(hash).await.map_err(|e| transfer(&e))?;
        Ok(bytes.into())
    }

    /// Bytes under the blob store's directory (its index, outboards and owned copies).
    pub fn store_bytes(&self) -> u64 {
        dir_bytes(&self.blobs_dir)
    }

    pub async fn close(&self) {
        let _ = self.router.shutdown().await;
        let _ = self.store.shutdown().await;
    }
}

/// The size of every regular file under `dir`, never following a symbolic link.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(e.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(e.path());
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

/// Peak resident memory of this process in KiB (`VmHWM`), where the platform reports it.
pub fn rss_hwm_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|l| l.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_described_by_its_transport() {
        let ip: SocketAddr = "192.0.2.7:4433".parse().unwrap();
        assert_eq!(
            describe(&TransportAddr::Ip(ip), Some(12)),
            PathReport {
                kind: "direct",
                addr: Some(ip),
                relay: None,
                rtt_ms: Some(12),
            }
        );
        let relay: RelayUrl = "https://relay.example.net/".parse().unwrap();
        let p = describe(&TransportAddr::Relay(relay), None);
        assert_eq!(p.kind, "relay");
        assert_eq!(p.addr, None);
        assert_eq!(p.relay.as_deref(), Some("relay.example.net"));
    }

    /// NFX-18: relays and global addresses stay; every other direct address goes.
    #[test]
    fn only_global_keeps_relays_and_global_addresses() {
        // A key made at run time: no key material in the source.
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).unwrap();
        let id = SecretKey::from(seed).public();
        let relay: RelayUrl = "https://relay.example.net/".parse().unwrap();
        let ip = |s: &str| TransportAddr::Ip(s.parse().unwrap());
        let kept = [
            TransportAddr::Relay(relay),
            ip("8.8.8.8:4433"),
            ip("[2606:4700::1111]:4433"),
        ];
        let dropped = [
            "10.0.0.5:4433",
            "172.20.1.1:4433",
            "192.168.8.2:4433",
            "127.0.0.1:4433",
            "169.254.169.254:80",
            "100.64.0.3:4433",
            "8.8.8.8:0",
            "[::1]:4433",
            "[fe80::1]:4433",
            "[fd00::1]:4433",
            "[::ffff:192.168.1.1]:4433",
            "[2001:db8::1]:4433",
        ];
        let seen = EndpointAddr::from_parts(
            id,
            kept.iter().cloned().chain(dropped.iter().map(|s| ip(s))),
        );
        assert_eq!(only_global(seen), EndpointAddr::from_parts(id, kept));
    }

    /// NFX-18: unless asked, neither `addr` nor a ticket names a non-global direct address.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_node_hands_out_local_addresses_only_when_asked() {
        let dir = std::env::temp_dir().join(format!("iroh-helper-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let global = |a: &String| {
            let a: SocketAddr = a.parse().unwrap();
            a.port() != 0 && candidates::allowed(a.ip(), false)
        };
        for local_addrs in [false, true] {
            let node = Node::spawn(
                &dir.join(local_addrs.to_string()),
                None,
                vec![],
                false,
                false,
                local_addrs,
                vec![],
            )
            .await
            .unwrap();
            let own: Vec<String> = node
                .endpoint()
                .addr()
                .ip_addrs()
                .map(ToString::to_string)
                .collect();
            let reach = node.reach();
            let file = dir.join(format!("f-{local_addrs}"));
            std::fs::write(&file, b"nfx").unwrap();
            let (hash, _) = node.import(file).await.unwrap();
            let (_, ticket) = node.seq(&[hash], "test/local").await.unwrap();
            let parts = decode_ticket(&ticket.to_string()).unwrap();
            if local_addrs {
                // Every local address the endpoint has is handed out (a CI host has some).
                for a in own.iter().filter(|a| !global(a)) {
                    assert!(reach.addrs.contains(a), "{a} not in {:?}", reach.addrs);
                    assert!(parts.addrs.contains(a), "{a} not in {:?}", parts.addrs);
                }
            } else {
                assert!(
                    reach.addrs.iter().all(global),
                    "{:?} (host: {own:?})",
                    reach.addrs
                );
                assert!(
                    parts.addrs.iter().all(global),
                    "{:?} (host: {own:?})",
                    parts.addrs
                );
            }
            node.close().await;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two nodes on one machine, no relay: the dialler's selected path is the other's socket.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_direct_connection_reports_its_remote_address() {
        let dir = std::env::temp_dir().join(format!("iroh-helper-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = Node::spawn(&dir.join("a"), None, vec![], false, false, false, vec![])
            .await
            .unwrap();
        let b = Node::spawn(&dir.join("b"), None, vec![], false, false, false, vec![])
            .await
            .unwrap();
        let port = b
            .endpoint()
            .bound_sockets()
            .into_iter()
            .find(SocketAddr::is_ipv4)
            .unwrap()
            .port();
        let to = SocketAddr::from(([127, 0, 0, 1], port));
        let conn = a
            .dial(a.trusted(b.endpoint().id(), &[], &[to]))
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let report = loop {
            let r = path_of(&conn);
            if r.kind != "none" || tokio::time::Instant::now() > deadline {
                break r;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(report.kind, "direct");
        let addr = report.addr.unwrap();
        assert_eq!(addr.port(), port);
        assert!(
            addr.ip().to_canonical().is_loopback(),
            "{addr:?} is not loopback"
        );
        assert!(report.rtt_ms.is_some());
        drop(conn);
        a.close().await;
        b.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The worker's NFX store files are imported by reference. Untagging them (a video dropped)
    /// and the collector that follows must forget them, never delete the worker's copy.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_collector_never_deletes_a_referenced_file() {
        let dir = std::env::temp_dir().join(format!("iroh-helper-gc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("store-file");
        let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &bytes).unwrap();

        let node = Node::spawn(
            &dir.join("state"),
            None,
            vec![],
            false,
            false,
            false,
            vec![],
        )
        .await
        .unwrap();
        let (hash, size) = node.import(file.clone()).await.unwrap();
        assert_eq!(size, bytes.len() as u64);
        node.seq(&[hash], "test/one").await.unwrap();
        node.store.tags().delete_all().await.unwrap();
        // Past one collection: GC_INTERVAL plus slack.
        tokio::time::sleep(GC_INTERVAL + Duration::from_secs(3)).await;

        assert_eq!(
            std::fs::read(&file).unwrap(),
            bytes,
            "a referenced file was changed"
        );
        node.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
