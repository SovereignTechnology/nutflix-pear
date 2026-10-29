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
    blobs_dir: PathBuf,
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

    pub fn reach(&self) -> Reach {
        let addr = self.endpoint().addr();
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
        let ticket = BlobTicket::new(self.endpoint().addr(), added.hash, BlobFormat::HashSeq);
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

        let node = Node::spawn(&dir.join("state"), None, vec![], false, false)
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
