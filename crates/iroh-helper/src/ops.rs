//! The request loop (README.md, "Requests"). Requests are JSON control frames with an `id`;
//! each gets exactly one reply with the same `id`. A `get` sends its bytes as data frames
//! tagged with its `id` before its reply.
//!
//! Every reply states facts (a hash, a size, an address). None says the bytes are right: the
//! helper never hands the worker a "verified" flag (nfx ADR 0103, sharp edge 1). BLAKE3 is
//! checked on the wire by iroh-blobs; the sha256 that decides is checked by the worker.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use iroh::RelayUrl;
use iroh::endpoint::Connection;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, OnceCell, Semaphore, mpsc};

use crate::frames::{self, Frame, FrameError, MAX_PAYLOAD};
use crate::node::{self, GetError, Node};
use crate::{EXIT_IO, EXIT_PROTOCOL};

/// Requests being answered at once; one more is refused `busy`, never queued.
pub const MAX_INFLIGHT: usize = 16;
/// Open connections (`dial`) at once.
pub const MAX_CONNS: usize = 16;
/// The largest `max` a `get` accepts: above any NFX file the packagers write (a segment is
/// capped at 64 MiB, a hash list at 16 MiB).
pub const MAX_GET_BYTES: u64 = 64 * 1024 * 1024;
/// The `max` of every `get` in flight together, in MiB: what the helper may hold in memory for
/// fetched blobs at once, whatever the worker asks (the worker bounds itself lower, 128 MiB).
pub const GET_BUDGET_MIB: u32 = 256;
/// Members in one `seq`.
pub const MAX_SEQ_MEMBERS: usize = 100_000;
/// Relay CAs in `init`, and the size of each (DER).
pub const MAX_RELAY_CAS: usize = 4;
pub const MAX_RELAY_CA_BYTES: usize = 8192;
/// Frames waiting for stdout. A worker that stops reading stalls the helper here, and so
/// every transfer behind it: the bound on what the helper holds for an unread pipe.
const OUT_QUEUE: usize = 16;
/// How long a shutdown may take before the process just exits.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Op {
    Init {
        #[serde(default)]
        secret: Option<String>,
        #[serde(default)]
        relays: Vec<String>,
        #[serde(default)]
        relay_only: bool,
        /// Off unless asked: a viewer's node has no business opening ports on the gateway.
        #[serde(default)]
        portmapper: bool,
        /// Extra trust anchors (DER, hex) for the relays' TLS only, beside iroh's embedded roots:
        /// a network whose relays use a private CA. Never consulted for iroh connections.
        #[serde(default)]
        relay_cas: Vec<String>,
    },
    Addr,
    Import {
        path: String,
    },
    Seq {
        members: Vec<String>,
        tag: String,
    },
    Untag {
        tag: String,
    },
    Ticket {
        ticket: String,
    },
    Dial {
        node: String,
        #[serde(default)]
        relays: Vec<String>,
        #[serde(default)]
        addrs: Vec<String>,
    },
    Get {
        conn: u32,
        hash: String,
        max: u64,
    },
    Hangup {
        conn: u32,
    },
    Stats,
}

struct OpError {
    code: &'static str,
    msg: String,
}

fn err(code: &'static str, msg: impl Into<String>) -> OpError {
    OpError {
        code,
        msg: msg.into(),
    }
}

type OpResult = Result<Map<String, Value>, OpError>;

fn fields(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

struct Conns {
    next: u32,
    open: HashMap<u32, Connection>,
}

struct Shared {
    state: PathBuf,
    node: OnceCell<Node>,
    conns: Mutex<Conns>,
    inflight: Arc<Semaphore>,
    /// [`GET_BUDGET_MIB`] permits, one per MiB of `max`.
    get_budget: Arc<Semaphore>,
}

type Out = mpsc::Sender<Vec<u8>>;

/// `NUTFLIX_IROH_HELPER_TRACE` set: each request's id and op, and each reply's id and outcome,
/// on stderr. Never a field's value, so never a secret or a path.
fn trace() -> bool {
    static TRACE: OnceLock<bool> = OnceLock::new();
    *TRACE.get_or_init(|| std::env::var_os("NUTFLIX_IROH_HELPER_TRACE").is_some())
}

/// One reply frame. `Err` means stdout is gone.
async fn reply(out: &Out, id: u32, result: OpResult) -> Result<(), ()> {
    let mut m = match result {
        Ok(mut m) => {
            m.insert("ok".into(), Value::Bool(true));
            m
        }
        Err(e) => {
            let mut m = Map::new();
            m.insert("ok".into(), Value::Bool(false));
            m.insert("err".into(), Value::String(e.code.into()));
            m.insert("msg".into(), Value::String(e.msg));
            m
        }
    };
    m.insert("id".into(), Value::from(id));
    if trace() {
        let outcome = m.get("err").and_then(Value::as_str).unwrap_or("ok");
        eprintln!("nutflix-iroh-helper: trace reply {id} {outcome}");
    }
    let mut bytes = serde_json::to_vec(&Value::Object(m)).map_err(|_| ())?;
    if bytes.len() > MAX_PAYLOAD {
        // Only a huge address list could do this; the worker still gets an answer.
        bytes = serde_json::to_vec(&json!({"id": id, "ok": false, "err": "too-large", "msg": "reply over the frame limit"}))
            .map_err(|_| ())?;
    }
    let frame = frames::encode_ctl(&bytes).ok_or(())?;
    out.send(frame).await.map_err(|_| ())
}

fn relay_urls(list: &[String]) -> Result<Vec<RelayUrl>, OpError> {
    list.iter()
        .map(|u| {
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err(err("bad-request", format!("relay {u:?} is not http(s)")));
            }
            u.parse()
                .map_err(|_| err("bad-request", format!("relay {u:?} is not a URL")))
        })
        .collect()
}

fn socket_addrs(list: &[String]) -> Result<Vec<SocketAddr>, OpError> {
    list.iter()
        .map(|a| {
            a.parse()
                .map_err(|_| err("bad-request", format!("{a:?} is not ip:port")))
        })
        .collect()
}

fn reach(node: &Node) -> Map<String, Value> {
    let r = node.reach();
    fields(json!({"node": r.node, "relay": r.relay, "addrs": r.addrs}))
}

impl Shared {
    fn node(&self) -> Result<&Node, OpError> {
        self.node
            .get()
            .ok_or_else(|| err("not-ready", "init first"))
    }

    async fn init(
        &self,
        secret: Option<String>,
        relays: Vec<String>,
        relay_only: bool,
        portmapper: bool,
        relay_cas: Vec<String>,
    ) -> OpResult {
        if self.node.initialized() {
            return Err(err("bad-request", "init was already done"));
        }
        let secret = match secret {
            None => None,
            Some(s) => {
                let mut key = [0u8; 32];
                hex::decode_to_slice(&s, &mut key)
                    .map_err(|_| err("bad-request", "secret is not 64 hex"))?;
                Some(key)
            }
        };
        let relays = relay_urls(&relays)?;
        if relay_only && relays.is_empty() {
            return Err(err("bad-request", "relay_only needs a relay"));
        }
        if relay_cas.len() > MAX_RELAY_CAS {
            return Err(err("bad-request", "at most 4 relay CAs"));
        }
        let relay_cas = relay_cas
            .iter()
            .map(|h| match hex::decode(h) {
                Ok(der) if !der.is_empty() && der.len() <= MAX_RELAY_CA_BYTES => Ok(der),
                _ => Err(err(
                    "bad-request",
                    "a relay CA is not 1-8192 bytes of DER in hex",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let node = Node::spawn(
            &self.state,
            secret,
            relays,
            relay_only,
            portmapper,
            relay_cas,
        )
        .await
        .map_err(|e| err("io", e))?;
        let answer = reach(&node);
        self.node
            .set(node)
            .map_err(|_| err("bad-request", "init was already done"))?;
        Ok(answer)
    }

    async fn handle(&self, id: u32, op: Op, out: &Out) -> OpResult {
        match op {
            Op::Init { .. } => Err(err("bad-request", "init is handled in order")),
            Op::Addr => Ok(reach(self.node()?)),
            Op::Import { path } => {
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err(err("bad-request", "path must be absolute"));
                }
                let (hash, size) = self.node()?.import(path).await.map_err(|e| err("io", e))?;
                Ok(fields(json!({"hash": node::hex_hash(&hash), "size": size})))
            }
            Op::Seq { members, tag } => {
                if !valid_tag(&tag) {
                    return Err(err("bad-request", "tag must be 1-128 of [a-z0-9:._/-]"));
                }
                if members.is_empty() || members.len() > MAX_SEQ_MEMBERS {
                    return Err(err("bad-request", "a seq has 1 to 100000 members"));
                }
                let hashes = members
                    .iter()
                    .map(|m| {
                        node::parse_hash(m)
                            .ok_or_else(|| err("bad-request", format!("{m:?} is not a hash")))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let (hash, ticket) = self
                    .node()?
                    .seq(&hashes, &tag)
                    .await
                    .map_err(|e| err("io", e))?;
                Ok(fields(
                    json!({"hash": node::hex_hash(&hash), "ticket": ticket.to_string()}),
                ))
            }
            Op::Untag { tag } => {
                if !valid_tag(&tag) {
                    return Err(err("bad-request", "tag must be 1-128 of [a-z0-9:._/-]"));
                }
                let n = self.node()?.untag(&tag).await.map_err(|e| err("io", e))?;
                Ok(fields(json!({"deleted": n})))
            }
            Op::Ticket { ticket } => {
                let t = node::decode_ticket(&ticket).map_err(|e| err("bad-request", e))?;
                Ok(fields(json!({
                    "node": t.node, "hash": t.hash, "format": t.format,
                    "relays": t.relays, "addrs": t.addrs,
                })))
            }
            Op::Dial {
                node: id,
                relays,
                addrs,
            } => {
                let node = self.node()?;
                let id = node::parse_id(&id)
                    .ok_or_else(|| err("bad-request", "node is not an endpoint id"))?;
                let relays = relay_urls(&relays)?;
                let addrs = socket_addrs(&addrs)?;
                if self.conns.lock().await.open.len() >= MAX_CONNS {
                    return Err(err("busy", "too many open connections"));
                }
                let conn = node
                    .dial(node.trusted(id, &relays, &addrs))
                    .await
                    .map_err(|e| err("dial-failed", e))?;
                let mut conns = self.conns.lock().await;
                if conns.open.len() >= MAX_CONNS {
                    return Err(err("busy", "too many open connections"));
                }
                conns.next = conns.next.checked_add(1).unwrap_or(1);
                let handle = conns.next;
                conns.open.insert(handle, conn);
                Ok(fields(json!({"conn": handle})))
            }
            Op::Get { conn, hash, max } => {
                if max == 0 || max > MAX_GET_BYTES {
                    return Err(err("bad-request", "max must be 1 to 64 MiB"));
                }
                // `max` is at most 64 MiB, so this is at most 64 permits.
                let mib = u32::try_from(max.div_ceil(1024 * 1024)).unwrap_or(GET_BUDGET_MIB);
                let _budget = self
                    .get_budget
                    .clone()
                    .try_acquire_many_owned(mib)
                    .map_err(|_| err("busy", "too many bytes in flight"))?;
                let hash = node::parse_hash(&hash)
                    .ok_or_else(|| err("bad-request", "hash is not 64 hex"))?;
                let connection = self
                    .conns
                    .lock()
                    .await
                    .open
                    .get(&conn)
                    .cloned()
                    .ok_or_else(|| err("no-conn", "no such connection"))?;
                let bytes =
                    self.node()?
                        .get(&connection, hash, max)
                        .await
                        .map_err(|e| match e {
                            GetError::Timeout => err("timeout", "the peer did not send in time"),
                            GetError::TooLarge => {
                                err("too-large", "larger than max, or incomplete")
                            }
                            GetError::Transfer(m) => err("transfer-failed", m),
                        })?;
                for chunk in bytes.chunks(MAX_PAYLOAD) {
                    let frame = frames::encode_data(id, chunk)
                        .ok_or_else(|| err("internal", "chunking"))?;
                    out.send(frame)
                        .await
                        .map_err(|_| err("io", "stdout is gone"))?;
                }
                Ok(fields(json!({"size": bytes.len()})))
            }
            Op::Hangup { conn } => {
                // Dropping the last handle closes the connection.
                let closed = self.conns.lock().await.open.remove(&conn).is_some();
                Ok(fields(json!({"closed": closed})))
            }
            Op::Stats => {
                let node = self.node()?;
                Ok(fields(json!({
                    "rss_hwm_kib": node::rss_hwm_kib(),
                    "store_bytes": node.store_bytes(),
                })))
            }
        }
    }
}

fn valid_tag(tag: &str) -> bool {
    (1..=128).contains(&tag.len())
        && tag
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b":._/-".contains(&c))
}

fn spawn_writer(mut rx: mpsc::Receiver<Vec<u8>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = rx.recv().await {
            if stdout.write_all(&frame).await.is_err() {
                return;
            }
            // Flush when nothing else is waiting, so a burst of frames is one write.
            if rx.is_empty() && stdout.flush().await.is_err() {
                return;
            }
        }
        let _ = stdout.flush().await;
    })
}

/// Serve requests from stdin until it ends; the process's exit code.
pub async fn serve(state: &Path) -> u8 {
    let (tx, rx) = mpsc::channel::<Vec<u8>>(OUT_QUEUE);
    let writer = spawn_writer(rx);
    let shared = Arc::new(Shared {
        state: state.to_path_buf(),
        node: OnceCell::new(),
        conns: Mutex::new(Conns {
            next: 0,
            open: HashMap::new(),
        }),
        inflight: Arc::new(Semaphore::new(MAX_INFLIGHT)),
        get_budget: Arc::new(Semaphore::new(GET_BUDGET_MIB as usize)),
    });
    let mut stdin = BufReader::new(tokio::io::stdin());
    let code = loop {
        let body = match frames::read_frame(&mut stdin).await {
            Ok(None) => break 0,
            Ok(Some(Frame::Ctl(body))) => body,
            Ok(Some(Frame::Data { .. })) => {
                // Reserved for `nfx/pay/1` streams (Phase 2): nothing sends them yet.
                eprintln!("nutflix-iroh-helper: data frame from the worker");
                break EXIT_PROTOCOL;
            }
            Err(FrameError::Io(e)) => {
                eprintln!("nutflix-iroh-helper: stdin: {e}");
                break EXIT_IO;
            }
            Err(e) => {
                eprintln!("nutflix-iroh-helper: {e}");
                break EXIT_PROTOCOL;
            }
        };
        let value: Value = match serde_json::from_slice(&body) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                eprintln!("nutflix-iroh-helper: a control frame is not a JSON object");
                break EXIT_PROTOCOL;
            }
        };
        let Some(id) = value
            .get("id")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n != 0)
        else {
            eprintln!("nutflix-iroh-helper: a request without an id");
            break EXIT_PROTOCOL;
        };
        // serde's message can quote a field's value; for `init` that could be the secret.
        let is_init = value.get("op").and_then(Value::as_str) == Some("init");
        if trace() {
            let op = value.get("op").and_then(Value::as_str).unwrap_or("?");
            // The op name only if it is one of ours (it is the worker's text).
            let op = if op.len() <= 16 && op.bytes().all(|c| c.is_ascii_lowercase() || c == b'-') {
                op
            } else {
                "?"
            };
            eprintln!("nutflix-iroh-helper: trace recv {id} {op}");
        }
        let op: Op = match serde_json::from_value(value) {
            Ok(op) => op,
            Err(e) => {
                let msg = if is_init {
                    "malformed init".to_owned()
                } else {
                    e.to_string()
                };
                if reply(&tx, id, Err(err("bad-request", msg))).await.is_err() {
                    break EXIT_IO;
                }
                continue;
            }
        };
        if let Op::Init {
            secret,
            relays,
            relay_only,
            portmapper,
            relay_cas,
        } = op
        {
            // In order: nothing else is served before it answers.
            let result = shared
                .init(secret, relays, relay_only, portmapper, relay_cas)
                .await;
            if reply(&tx, id, result).await.is_err() {
                break EXIT_IO;
            }
            continue;
        }
        let Ok(permit) = shared.inflight.clone().try_acquire_owned() else {
            if reply(&tx, id, Err(err("busy", "too many requests at once")))
                .await
                .is_err()
            {
                break EXIT_IO;
            }
            continue;
        };
        let (shared, out) = (shared.clone(), tx.clone());
        tokio::spawn(async move {
            let result = shared.handle(id, op, &out).await;
            let _ = reply(&out, id, result).await;
            drop(permit);
        });
    };
    if let Some(node) = shared.node.get() {
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, node.close()).await;
    }
    drop(tx);
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, writer).await;
    code
}
