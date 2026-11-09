//! The helper's WebRTC side (ADR 0023): data-channel connections with browsers in an NFX web
//! swarm (NFX-10 §2), speaking p2p-media-loader's peer protocol ([`p2pml`]). Full ICE, so it
//! works behind a NAT, on one UDP socket with a STUN client ([`stun`]) for the public mapping.
//!
//! It does not signal. The worker hands it a remote offer and gets an answer back, or asks for
//! an offer and hands it the answer; how those travel (Nostr, per nfx #71) is the host's
//! business. It never decides a segment is right: it serves files the worker names, reading them
//! when asked, and hands fetched bytes to the worker, which checks their sha256 (ADR 0021 §3).
//!
//! One task owns the socket and every connection: str0m is sans-IO, so the task feeds it
//! datagrams and timeouts and sends what it asks to send. The worker's requests reach the task
//! over a channel; events (a channel opened, a peer announced segments, a peer left) wait in a
//! bounded queue the worker drains with a long poll.

pub mod candidates;
pub mod p2pml;
pub mod stun;

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{Notify, mpsc, oneshot};

use p2pml::Command;

/// Connections at once, and per swarm.
pub const MAX_PEERS: usize = 32;
pub const MAX_PER_SWARM: usize = 8;
/// Swarms served at once, and segments in one.
pub const MAX_SWARMS: usize = 64;
pub const MAX_SEGMENTS: usize = 100_000;
/// The largest segment served or fetched: NFX's packagers cap a segment at 64 MiB.
pub const MAX_SEGMENT: u64 = 64 * 1024 * 1024;
/// An SDP the worker hands in (a tracker caps one at 8 KiB; Nostr events are smaller still).
pub const MAX_SDP: usize = 16 * 1024;
/// STUN servers.
pub const MAX_STUN: usize = 4;
/// Events waiting for a poll; older ones are dropped and the next poll says so.
pub const MAX_EVENTS: usize = 256;
/// Ranges in one `have` event.
pub const MAX_RANGES: usize = 512;

/// The data channel's label: what p2p-media-loader's WebTorrent client opens.
const CHANNEL: &str = "webtorrent";
/// A connection's channel must be open this soon, and is closed after this long idle.
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Commands waiting to be written to one peer.
const MAX_QUEUED: usize = 4 * 1024 * 1024;
/// Segment bytes go out in messages of at most this, well under every browser's limit.
const CHUNK: usize = 16 * 1024;
/// Requests a peer may make: a burst, then a rate. Above it the peer is dropped.
const PEER_BURST: f64 = 60.0;
const PEER_RATE: f64 = 20.0;
/// Requests all peers together are served: above it, `Absent`.
const GLOBAL_BURST: f64 = 400.0;
const GLOBAL_RATE: f64 = 200.0;
/// Files read at once, requests waiting for a read, and segment bytes held for uploads.
const MAX_READS: usize = 4;
const MAX_WAITING: usize = 64;
const MAX_HELD: usize = 256 * 1024 * 1024;
/// A fetch fails if the peer does not start in this long, stalls this long, or takes this long.
const GET_FIRST: Duration = Duration::from_secs(5);
const GET_STALL: Duration = Duration::from_secs(5);
const GET_TOTAL: Duration = Duration::from_secs(30);
/// STUN: the first round's wait at start, and the time between rounds (a NAT keeps a UDP
/// mapping for 30 s at least, RFC 4787 REQ-5).
const STUN_WAIT: Duration = Duration::from_secs(3);
const STUN_EVERY: Duration = Duration::from_secs(25);
const STUN_RETRY: Duration = Duration::from_secs(3);
/// The longest the task sleeps without looking at its timers.
const TICK: Duration = Duration::from_millis(250);

/// A failed request: an error code the worker matches on (README.md) and a message.
#[derive(Debug)]
pub struct RtcError {
    pub code: &'static str,
    pub msg: String,
}

fn fail(code: &'static str, msg: impl Into<String>) -> RtcError {
    RtcError {
        code,
        msg: msg.into(),
    }
}

/// What `rtc-init` asks for.
pub struct Config {
    /// The address to bind; with an unspecified IP (or none) the default route's address.
    pub bind: Option<SocketAddr>,
    /// STUN servers, `host:port`.
    pub stun: Vec<String>,
    /// Tests and same-LAN runs only: private and loopback addresses count as reachable.
    pub allow_private: bool,
}

/// One segment the helper serves: its position in the rendition playlist, the file that holds
/// it, and that file's size.
pub struct Segment {
    pub id: u64,
    pub path: PathBuf,
    pub size: u64,
}

struct Events {
    queue: Mutex<VecDeque<Value>>,
    lost: AtomicBool,
    notify: Notify,
    polling: AtomicBool,
}

impl Events {
    fn push(&self, v: Value) {
        if let Ok(mut q) = self.queue.lock() {
            if q.len() >= MAX_EVENTS {
                q.pop_front();
                self.lost.store(true, Ordering::Relaxed);
            }
            q.push_back(v);
        }
        self.notify.notify_one();
    }

    /// Events in order, as many as fit in `max_bytes` of JSON (at least one).
    fn take(&self, max_bytes: usize) -> (Vec<Value>, bool) {
        let mut out = Vec::new();
        let mut size = 0;
        if let Ok(mut q) = self.queue.lock() {
            while let Some(v) = q.front() {
                let len = serde_json::to_vec(v).map_or(0, |b| b.len() + 1);
                if !out.is_empty() && size + len > max_bytes {
                    break;
                }
                size += len;
                if let Some(v) = q.pop_front() {
                    out.push(v);
                }
            }
        }
        (out, self.lost.swap(false, Ordering::Relaxed))
    }
}

enum Cmd {
    Serve {
        swarm: String,
        segments: Vec<Segment>,
        append: bool,
        reply: oneshot::Sender<Result<usize, RtcError>>,
    },
    Unserve {
        swarm: String,
        reply: oneshot::Sender<Result<bool, RtcError>>,
    },
    Answer {
        swarm: String,
        offer: String,
        reply: oneshot::Sender<Result<Sdp, RtcError>>,
    },
    Offer {
        swarm: String,
        reply: oneshot::Sender<Result<Sdp, RtcError>>,
    },
    Accept {
        peer: u32,
        answer: String,
        reply: oneshot::Sender<Result<usize, RtcError>>,
    },
    Get {
        peer: u32,
        id: u64,
        max: u64,
        reply: oneshot::Sender<Result<Vec<u8>, RtcError>>,
    },
    Hangup {
        peer: u32,
        reply: oneshot::Sender<Result<bool, RtcError>>,
    },
    Status {
        reply: oneshot::Sender<Result<Value, RtcError>>,
    },
}

/// A new connection's id and the SDP to send to the other side, with how many candidates it
/// shows.
#[derive(Debug)]
pub struct Sdp {
    pub peer: u32,
    pub sdp: String,
    pub candidates: usize,
}

/// The worker's handle on the running WebRTC side. Dropping it ends the task, which closes every
/// connection on its way out; [`Self::stop`] also waits for that.
pub struct RtcHandle {
    tx: mpsc::Sender<Cmd>,
    events: Arc<Events>,
    task: tokio::task::JoinHandle<()>,
    pub local: SocketAddr,
    pub mapped: Option<SocketAddr>,
}

fn valid_swarm(s: &str) -> bool {
    (1..=256).contains(&s.len()) && s.bytes().all(|c| (0x21..=0x7e).contains(&c))
}

impl RtcHandle {
    /// Bind the socket, learn the public mapping (up to [`STUN_WAIT`]) and start the task.
    pub async fn start(cfg: Config) -> Result<Self, RtcError> {
        if cfg.stun.len() > MAX_STUN {
            return Err(fail("bad-request", "at most 4 STUN servers"));
        }
        let mut servers = Vec::new();
        for s in &cfg.stun {
            if s.len() > 300 || !s.contains(':') {
                return Err(fail("bad-request", format!("{s:?} is not host:port")));
            }
            // A name that does not resolve is skipped: the side still starts, without a mapping.
            if let Ok(mut addrs) = tokio::net::lookup_host(s.as_str()).await
                && let Some(a) = addrs.next()
            {
                servers.push(a);
            }
        }
        let local = local_addr(cfg.bind, servers.first().copied())?;
        servers.retain(|s| s.is_ipv4() == local.is_ipv4());
        let socket = UdpSocket::bind(local)
            .await
            .map_err(|e| fail("io", format!("bind: {e}")))?;
        let local = socket
            .local_addr()
            .map_err(|e| fail("io", format!("bind: {e}")))?;
        let mapped = first_mapping(&socket, &servers).await;
        let events = Arc::new(Events {
            queue: Mutex::new(VecDeque::new()),
            lost: AtomicBool::new(false),
            notify: Notify::new(),
            polling: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel(64);
        let (done_tx, done_rx) = mpsc::channel(MAX_READS * 2);
        let now = Instant::now();
        let engine = Engine {
            socket: Arc::new(socket),
            local,
            allow_private: cfg.allow_private,
            servers,
            stun_txs: HashMap::new(),
            mapped,
            stun_next: now
                + if mapped.is_some() {
                    STUN_EVERY
                } else {
                    STUN_RETRY
                },
            peers: HashMap::new(),
            next_peer: 0,
            swarms: HashMap::new(),
            waiting: VecDeque::new(),
            reading: 0,
            held: 0,
            done_tx,
            budget: Bucket::new(GLOBAL_BURST, now),
            events: events.clone(),
        };
        let task = tokio::spawn(run(engine, rx, done_rx));
        Ok(Self {
            tx,
            events,
            task,
            local,
            mapped,
        })
    }

    /// Close every connection and the socket; waits up to 2 s for the task to finish.
    pub async fn stop(self) {
        let Self { tx, task, .. } = self;
        drop(tx);
        let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
    }

    async fn call<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, RtcError>>) -> Cmd,
    ) -> Result<T, RtcError> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(make(reply))
            .await
            .map_err(|_| fail("internal", "the WebRTC task is gone"))?;
        rx.await
            .map_err(|_| fail("internal", "the WebRTC task is gone"))?
    }

    /// Serve `segments` in `swarm` (replacing what it served, unless `append`). Returns how
    /// many segments the swarm now has.
    pub async fn serve(
        &self,
        swarm: String,
        segments: Vec<Segment>,
        append: bool,
    ) -> Result<usize, RtcError> {
        if !valid_swarm(&swarm) {
            return Err(fail("bad-request", "swarm must be 1-256 printable ASCII"));
        }
        for s in &segments {
            if !s.path.is_absolute() {
                return Err(fail("bad-request", "paths must be absolute"));
            }
            if s.size == 0 || s.size > MAX_SEGMENT {
                return Err(fail("bad-request", "a segment is 1 byte to 64 MiB"));
            }
            if s.id > p2pml::MAX_INT {
                return Err(fail("bad-request", "segment id out of range"));
            }
        }
        self.call(|reply| Cmd::Serve {
            swarm,
            segments,
            append,
            reply,
        })
        .await
    }

    pub async fn unserve(&self, swarm: String) -> Result<bool, RtcError> {
        self.call(|reply| Cmd::Unserve { swarm, reply }).await
    }

    /// Answer a remote offer for `swarm`: the browser asked to connect.
    pub async fn answer(&self, swarm: String, offer: String) -> Result<Sdp, RtcError> {
        if !valid_swarm(&swarm) {
            return Err(fail("bad-request", "swarm must be 1-256 printable ASCII"));
        }
        if offer.len() > MAX_SDP {
            return Err(fail("bad-request", "offer over 16 KiB"));
        }
        self.call(|reply| Cmd::Answer {
            swarm,
            offer,
            reply,
        })
        .await
    }

    /// Make an offer to a peer in `swarm`, to be completed by [`Self::accept`].
    pub async fn offer(&self, swarm: String) -> Result<Sdp, RtcError> {
        if !valid_swarm(&swarm) {
            return Err(fail("bad-request", "swarm must be 1-256 printable ASCII"));
        }
        self.call(|reply| Cmd::Offer { swarm, reply }).await
    }

    pub async fn accept(&self, peer: u32, answer: String) -> Result<usize, RtcError> {
        if answer.len() > MAX_SDP {
            return Err(fail("bad-request", "answer over 16 KiB"));
        }
        self.call(|reply| Cmd::Accept {
            peer,
            answer,
            reply,
        })
        .await
    }

    /// Segment `id` from `peer`, at most `max` bytes. Unchecked: the worker checks it.
    pub async fn get(&self, peer: u32, id: u64, max: u64) -> Result<Vec<u8>, RtcError> {
        if max == 0 || max > MAX_SEGMENT {
            return Err(fail("bad-request", "max must be 1 to 64 MiB"));
        }
        if id > p2pml::MAX_INT {
            return Err(fail("bad-request", "segment id out of range"));
        }
        self.call(|reply| Cmd::Get {
            peer,
            id,
            max,
            reply,
        })
        .await
    }

    pub async fn hangup(&self, peer: u32) -> Result<bool, RtcError> {
        self.call(|reply| Cmd::Hangup { peer, reply }).await
    }

    pub async fn status(&self) -> Result<Value, RtcError> {
        self.call(|reply| Cmd::Status { reply }).await
    }

    /// Events, waiting up to `wait` for the first. One poll at a time.
    pub async fn poll(
        &self,
        wait: Duration,
        max_bytes: usize,
    ) -> Result<(Vec<Value>, bool), RtcError> {
        if self.events.polling.swap(true, Ordering::AcqRel) {
            return Err(fail("busy", "another poll is waiting"));
        }
        struct Release<'a>(&'a AtomicBool);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _release = Release(&self.events.polling);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let (events, lost) = self.events.take(max_bytes);
            if !events.is_empty() || lost {
                return Ok((events, lost));
            }
            if tokio::time::timeout_at(deadline, self.events.notify.notified())
                .await
                .is_err()
            {
                return Ok((Vec::new(), false));
            }
        }
    }
}

/// The address to bind: `bind` if its IP is specific, else the address the default route
/// toward `toward` (the first STUN server) would leave from. Finding it sends nothing.
fn local_addr(
    bind: Option<SocketAddr>,
    toward: Option<SocketAddr>,
) -> Result<SocketAddr, RtcError> {
    let port = bind.map_or(0, |b| b.port());
    if let Some(b) = bind
        && !b.ip().is_unspecified()
    {
        return Ok(b);
    }
    let Some(toward) = toward else {
        return Err(fail(
            "bad-request",
            "give a bind address with a specific IP, or a STUN server that resolves",
        ));
    };
    let any = if toward.is_ipv4() {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)
    } else {
        SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0)
    };
    let probe = std::net::UdpSocket::bind(any).map_err(|e| fail("io", format!("route: {e}")))?;
    probe
        .connect(toward)
        .map_err(|e| fail("io", format!("no route to the STUN server: {e}")))?;
    let ip = probe
        .local_addr()
        .map_err(|e| fail("io", format!("route: {e}")))?
        .ip();
    Ok(SocketAddr::new(ip, port))
}

/// One round of Binding requests at start, waiting up to [`STUN_WAIT`] for the first answer.
async fn first_mapping(socket: &UdpSocket, servers: &[SocketAddr]) -> Option<SocketAddr> {
    let mut txs = HashMap::new();
    for s in servers {
        let tx = stun::tx()?;
        if socket.send_to(&stun::request(&tx), s).await.is_ok() {
            txs.insert(tx, *s);
        }
    }
    if txs.is_empty() {
        return None;
    }
    let mut buf = vec![0u8; 2048];
    let deadline = tokio::time::Instant::now() + STUN_WAIT;
    loop {
        let (n, from) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf))
            .await
            .ok()?
            .ok()?;
        let Some(tx) = stun::success_tx(&buf[..n]) else {
            continue;
        };
        if txs.get(&tx) == Some(&from)
            && let Some(m) = stun::mapped(&buf[..n], &tx)
        {
            return Some(m);
        }
    }
}

struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            at: now,
        }
    }

    fn take(&mut self, now: Instant, burst: f64, rate: f64) -> bool {
        self.tokens = (self.tokens + now.duration_since(self.at).as_secs_f64() * rate).min(burst);
        self.at = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

struct Swarm {
    segments: BTreeMap<u64, (PathBuf, u64)>,
}

/// An upload in progress: the segment's bytes, from where the next message starts, and the
/// `Completed` message that follows the last byte.
struct Upload {
    bytes: Vec<u8>,
    at: usize,
    tail: VecDeque<Vec<u8>>,
}

/// A fetch in progress (`rtc-get`).
struct Fetch {
    id: u64,
    request: u64,
    max: u64,
    size: Option<u64>,
    buf: Vec<u8>,
    start: Instant,
    last: Instant,
    reply: oneshot::Sender<Result<Vec<u8>, RtcError>>,
}

struct Peer {
    rtc: Rtc,
    swarm: String,
    outgoing: bool,
    pending: Option<SdpPendingOffer>,
    channel: Option<ChannelId>,
    joiner: p2pml::Joiner,
    /// Command messages waiting to be written.
    out: VecDeque<Vec<u8>>,
    queued: usize,
    /// The request the peer last asked us to send (being read, or sent).
    wanted: Option<u64>,
    upload: Option<Upload>,
    /// What the peer last announced it holds.
    have: BTreeSet<u64>,
    fetch: Option<Fetch>,
    next_request: u64,
    budget: Bucket,
    wake: Instant,
    born: Instant,
    active: Instant,
    dead: Option<&'static str>,
}

struct ReadJob {
    peer: u32,
    request: u64,
    id: u64,
    from: u64,
    path: PathBuf,
    size: u64,
}

struct ReadDone {
    peer: u32,
    request: u64,
    id: u64,
    from: u64,
    size: u64,
    bytes: Option<Vec<u8>>,
}

struct Engine {
    socket: Arc<UdpSocket>,
    local: SocketAddr,
    allow_private: bool,
    servers: Vec<SocketAddr>,
    stun_txs: HashMap<stun::TxId, SocketAddr>,
    mapped: Option<SocketAddr>,
    stun_next: Instant,
    peers: HashMap<u32, Peer>,
    next_peer: u32,
    swarms: HashMap<String, Swarm>,
    waiting: VecDeque<ReadJob>,
    reading: usize,
    /// Segment bytes being read or uploaded.
    held: usize,
    done_tx: mpsc::Sender<ReadDone>,
    budget: Bucket,
    events: Arc<Events>,
}

async fn run(mut e: Engine, mut rx: mpsc::Receiver<Cmd>, mut done: mpsc::Receiver<ReadDone>) {
    let mut buf = vec![0u8; 65536];
    loop {
        let wake = e.next_wake();
        let socket = e.socket.clone();
        tokio::select! {
            r = socket.recv_from(&mut buf) => {
                // An error here is an ICMP report on some systems: nothing to act on.
                if let Ok((n, from)) = r {
                    e.receive(&buf[..n], from);
                }
            }
            c = rx.recv() => match c {
                None => break,
                Some(c) => e.command(c),
            },
            Some(d) = done.recv() => e.read_done(d),
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(wake)) => e.timeout(),
        }
        e.pump_all();
        e.start_reads();
    }
    for p in e.peers.values_mut() {
        p.dead = Some("stopped");
    }
    e.pump_all();
}

/// The served ids one announcement can carry: at most 255 blocks of 256.
fn announceable(ids: impl Iterator<Item = u64>) -> Vec<u64> {
    let mut blocks = 0usize;
    let mut last = None;
    let mut out = Vec::new();
    for id in ids {
        let block = id >> 8;
        if last != Some(block) {
            if blocks == p2pml::MAX_GROUPS {
                break;
            }
            blocks += 1;
            last = Some(block);
        }
        out.push(id);
    }
    out
}

/// `ids` (sorted) as inclusive ranges, at most [`MAX_RANGES`]; `true` if some were left out.
fn ranges(ids: &BTreeSet<u64>) -> (Vec<[u64; 2]>, bool) {
    let mut out: Vec<[u64; 2]> = Vec::new();
    for &id in ids {
        match out.last_mut() {
            Some(r) if r[1] + 1 == id => r[1] = id,
            _ => {
                if out.len() == MAX_RANGES {
                    return (out, true);
                }
                out.push([id, id]);
            }
        }
    }
    (out, false)
}

/// What a peer's channel takes next: queued commands first, then the upload's bytes, then its
/// `Completed`.
#[derive(Clone, Copy)]
enum Next {
    Nothing,
    Command,
    Body(usize, usize),
    Tail,
    Finished,
}

fn next_write(p: &Peer) -> Next {
    if !p.out.is_empty() {
        return Next::Command;
    }
    let Some(u) = &p.upload else {
        return Next::Nothing;
    };
    if u.at < u.bytes.len() {
        let mut end = (u.at + CHUNK).min(u.bytes.len());
        // A message that looks like a command chunk would be read as one: cut earlier.
        while end - u.at > 1 && p2pml::is_command_chunk(&u.bytes[u.at..end]) {
            end -= 1;
        }
        return Next::Body(u.at, end);
    }
    if u.tail.is_empty() {
        Next::Finished
    } else {
        Next::Tail
    }
}

fn read_exact(path: &Path, size: u64) -> Option<Vec<u8>> {
    let f = std::fs::File::open(path).ok()?;
    if f.metadata().ok()?.len() != size {
        return None;
    }
    let mut bytes = Vec::with_capacity(usize::try_from(size).ok()?);
    f.take(size + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 == size).then_some(bytes)
}

fn queue(p: &mut Peer, cmd: &Command) {
    match p2pml::encode(cmd) {
        Ok(msgs) => {
            for m in msgs {
                p.queued += m.len();
                p.out.push_back(m);
            }
            if p.queued > MAX_QUEUED {
                p.dead = Some("queue");
            }
        }
        Err(_) => p.dead = Some("encode"),
    }
}

/// Stop the upload in progress, if any, freeing what it holds.
fn cancel_upload(p: &mut Peer, held: &mut usize) {
    if let Some(u) = p.upload.take() {
        *held = held.saturating_sub(u.bytes.len());
    }
}

fn fail_fetch(p: &mut Peer, code: &'static str, msg: &str, send_cancel: bool) {
    if let Some(f) = p.fetch.take() {
        if send_cancel {
            queue(
                p,
                &Command::Cancel {
                    id: f.id,
                    request: f.request,
                },
            );
        }
        let _ = f.reply.send(Err(fail(code, msg)));
    }
}

impl Engine {
    fn next_wake(&self) -> Instant {
        let now = Instant::now();
        let mut wake = (now + TICK).min(self.stun_next);
        for p in self.peers.values() {
            wake = wake.min(p.wake);
        }
        wake.max(now)
    }

    fn receive(&mut self, bytes: &[u8], from: SocketAddr) {
        if self.servers.contains(&from)
            && let Some(tx) = stun::success_tx(bytes)
            && self.stun_txs.get(&tx) == Some(&from)
        {
            self.stun_txs.remove(&tx);
            if let Some(m) = stun::mapped(bytes, &tx) {
                self.mapped = Some(m);
            }
            return;
        }
        let Ok(contents) = bytes.try_into() else {
            return;
        };
        let input = Input::Receive(
            Instant::now(),
            Receive {
                proto: Protocol::Udp,
                source: from,
                destination: self.local,
                contents,
            },
        );
        for p in self.peers.values_mut() {
            if p.dead.is_none() && p.rtc.accepts(&input) {
                if p.rtc.handle_input(input).is_err() {
                    p.dead = Some("rtc");
                }
                break;
            }
        }
    }

    fn stun_round(&mut self, now: Instant) {
        self.stun_txs.clear();
        for s in self.servers.clone() {
            let Some(tx) = stun::tx() else { continue };
            if self.socket.try_send_to(&stun::request(&tx), s).is_ok() {
                self.stun_txs.insert(tx, s);
            }
        }
        self.stun_next = now
            + if self.mapped.is_some() {
                STUN_EVERY
            } else {
                STUN_RETRY
            };
    }

    fn timeout(&mut self) {
        let now = Instant::now();
        if now >= self.stun_next {
            self.stun_round(now);
        }
        for p in self.peers.values_mut() {
            if p.dead.is_some() {
                continue;
            }
            if p.channel.is_none() && now.duration_since(p.born) > OPEN_TIMEOUT {
                p.dead = Some("open-timeout");
                continue;
            }
            if p.channel.is_some() && now.duration_since(p.active) > IDLE_TIMEOUT {
                p.dead = Some("idle");
                continue;
            }
            if let Some(f) = &p.fetch {
                let late = match f.size {
                    None => now.duration_since(f.start) > GET_FIRST,
                    Some(_) => now.duration_since(f.last) > GET_STALL,
                } || now.duration_since(f.start) > GET_TOTAL;
                if late {
                    fail_fetch(p, "timeout", "the peer did not send in time", true);
                }
            }
            if p.wake <= now && p.rtc.handle_input(Input::Timeout(now)).is_err() {
                p.dead = Some("rtc");
            }
        }
    }

    fn new_rtc(&self, now: Instant) -> Result<Rtc, RtcError> {
        let mut rtc = Rtc::builder().build(now);
        let host = Candidate::host(self.local, "udp")
            .map_err(|e| fail("internal", format!("host candidate: {e}")))?;
        rtc.add_local_candidate(host);
        if let Some(m) = self.mapped
            && m != self.local
            && let Ok(c) = Candidate::server_reflexive(m, self.local, "udp")
        {
            rtc.add_local_candidate(c);
        }
        Ok(rtc)
    }

    fn room(&self, swarm: &str) -> Result<(), RtcError> {
        let live = self.peers.values().filter(|p| p.dead.is_none());
        let (all, here) = live.fold((0, 0), |(a, h), p| {
            (a + 1, h + usize::from(p.swarm == swarm))
        });
        if all >= MAX_PEERS || here >= MAX_PER_SWARM {
            return Err(fail("busy", "too many connections"));
        }
        Ok(())
    }

    fn add_peer(
        &mut self,
        rtc: Rtc,
        swarm: String,
        outgoing: bool,
        pending: Option<SdpPendingOffer>,
    ) -> u32 {
        let now = Instant::now();
        loop {
            self.next_peer = self.next_peer.checked_add(1).unwrap_or(1);
            if !self.peers.contains_key(&self.next_peer) {
                break;
            }
        }
        let id = self.next_peer;
        self.peers.insert(
            id,
            Peer {
                rtc,
                swarm,
                outgoing,
                pending,
                channel: None,
                joiner: p2pml::Joiner::default(),
                out: VecDeque::new(),
                queued: 0,
                wanted: None,
                upload: None,
                have: BTreeSet::new(),
                fetch: None,
                next_request: 0,
                budget: Bucket::new(PEER_BURST, now),
                wake: now,
                born: now,
                active: now,
                dead: None,
            },
        );
        id
    }

    fn announcement(&self, swarm: &str) -> Command {
        let loaded = self
            .swarms
            .get(swarm)
            .map(|s| announceable(s.segments.keys().copied()))
            .unwrap_or_default();
        Command::Announcement {
            loaded,
            loading: Vec::new(),
        }
    }

    /// Tell the open peers of `swarm` what is served now.
    fn reannounce(&mut self, swarm: &str) {
        let cmd = self.announcement(swarm);
        for p in self.peers.values_mut() {
            if p.swarm == swarm && p.channel.is_some() && p.dead.is_none() {
                queue(p, &cmd);
            }
        }
    }

    fn command(&mut self, c: Cmd) {
        let now = Instant::now();
        match c {
            Cmd::Serve {
                swarm,
                segments,
                append,
                reply,
            } => {
                if !self.swarms.contains_key(&swarm) && self.swarms.len() >= MAX_SWARMS {
                    let _ = reply.send(Err(fail("busy", "too many swarms")));
                    return;
                }
                let s = self.swarms.entry(swarm.clone()).or_insert_with(|| Swarm {
                    segments: BTreeMap::new(),
                });
                if !append {
                    s.segments.clear();
                }
                for seg in segments {
                    s.segments.insert(seg.id, (seg.path, seg.size));
                }
                if s.segments.len() > MAX_SEGMENTS {
                    self.swarms.remove(&swarm);
                    let _ = reply.send(Err(fail("bad-request", "over 100000 segments in a swarm")));
                    return;
                }
                let n = s.segments.len();
                self.reannounce(&swarm);
                let _ = reply.send(Ok(n));
            }
            Cmd::Unserve { swarm, reply } => {
                let had = self.swarms.remove(&swarm).is_some();
                if had {
                    self.reannounce(&swarm);
                }
                let _ = reply.send(Ok(had));
            }
            Cmd::Answer {
                swarm,
                offer,
                reply,
            } => {
                let result = self.room(&swarm).and_then(|()| {
                    let (sdp, _) = candidates::remote(&offer, self.allow_private);
                    let offer = SdpOffer::from_sdp_string(&sdp)
                        .map_err(|e| fail("bad-request", format!("offer: {e}")))?;
                    let mut rtc = self.new_rtc(now)?;
                    let answer = rtc
                        .sdp_api()
                        .accept_offer(offer)
                        .map_err(|e| fail("bad-request", format!("offer: {e}")))?;
                    let (sdp, shown) =
                        candidates::local(&answer.to_sdp_string(), self.allow_private);
                    let peer = self.add_peer(rtc, swarm, false, None);
                    Ok(Sdp {
                        peer,
                        sdp,
                        candidates: shown,
                    })
                });
                let _ = reply.send(result);
            }
            Cmd::Offer { swarm, reply } => {
                let result = self.room(&swarm).and_then(|()| {
                    let mut rtc = self.new_rtc(now)?;
                    let mut api = rtc.sdp_api();
                    let _channel = api.add_channel(CHANNEL.into());
                    let (offer, pending) = api
                        .apply()
                        .ok_or_else(|| fail("internal", "no offer to make"))?;
                    let (sdp, shown) =
                        candidates::local(&offer.to_sdp_string(), self.allow_private);
                    let peer = self.add_peer(rtc, swarm, true, Some(pending));
                    Ok(Sdp {
                        peer,
                        sdp,
                        candidates: shown,
                    })
                });
                let _ = reply.send(result);
            }
            Cmd::Accept {
                peer,
                answer,
                reply,
            } => {
                let allow_private = self.allow_private;
                let result = match self.peers.get_mut(&peer) {
                    None => Err(fail("no-peer", "no such connection")),
                    Some(p) => match p.pending.take() {
                        None => Err(fail(
                            "bad-request",
                            "that connection is not waiting for an answer",
                        )),
                        Some(pending) => {
                            let (sdp, kept) = candidates::remote(&answer, allow_private);
                            match SdpAnswer::from_sdp_string(&sdp) {
                                Err(e) => {
                                    p.dead = Some("bad-answer");
                                    Err(fail("bad-request", format!("answer: {e}")))
                                }
                                Ok(a) => match p.rtc.sdp_api().accept_answer(pending, a) {
                                    Err(e) => {
                                        p.dead = Some("bad-answer");
                                        Err(fail("bad-request", format!("answer: {e}")))
                                    }
                                    Ok(()) => Ok(kept),
                                },
                            }
                        }
                    },
                };
                let _ = reply.send(result);
            }
            Cmd::Get {
                peer,
                id,
                max,
                reply,
            } => {
                let Some(p) = self.peers.get_mut(&peer).filter(|p| p.dead.is_none()) else {
                    let _ = reply.send(Err(fail("no-peer", "no such connection")));
                    return;
                };
                if p.channel.is_none() {
                    let _ = reply.send(Err(fail("not-open", "the channel is not open yet")));
                    return;
                }
                if p.fetch.is_some() {
                    let _ = reply.send(Err(fail("busy", "a fetch from this peer is in progress")));
                    return;
                }
                // The library numbers its requests the same way: 1, 2, … below 10^9.
                p.next_request = (p.next_request + 1) % 1_000_000_000;
                let request = p.next_request;
                queue(
                    p,
                    &Command::Request {
                        id,
                        request,
                        from: 0,
                    },
                );
                p.active = now;
                p.fetch = Some(Fetch {
                    id,
                    request,
                    max,
                    size: None,
                    buf: Vec::new(),
                    start: now,
                    last: now,
                    reply,
                });
            }
            Cmd::Hangup { peer, reply } => {
                let found = match self.peers.get_mut(&peer) {
                    Some(p) if p.dead.is_none() => {
                        p.dead = Some("hangup");
                        true
                    }
                    _ => false,
                };
                let _ = reply.send(Ok(found));
            }
            Cmd::Status { reply } => {
                let live = self.peers.values().filter(|p| p.dead.is_none()).count();
                let _ = reply.send(Ok(json!({
                    "local": self.local.to_string(),
                    "mapped": self.mapped.map(|m| m.to_string()),
                    "peers": live,
                    "swarms": self.swarms.len(),
                    "held": self.held,
                })));
            }
        }
    }

    fn pump_all(&mut self) {
        let now = Instant::now();
        let mut peers = std::mem::take(&mut self.peers);
        for (&id, p) in &mut peers {
            if p.dead.is_none() {
                self.pump(id, p, now);
            }
        }
        for (&id, p) in peers.iter_mut().filter(|(_, p)| p.dead.is_some()) {
            let why = p.dead.unwrap_or("closed");
            fail_fetch(p, "closed", "the connection closed", false);
            cancel_upload(p, &mut self.held);
            // Let the close go out rather than leave the other side to time out.
            p.rtc.disconnect();
            while let Ok(out) = p.rtc.poll_output() {
                match out {
                    Output::Transmit(t) => {
                        let _ = self.socket.try_send_to(&t.contents, t.destination);
                    }
                    Output::Timeout(_) => break,
                    Output::Event(_) => {}
                }
            }
            self.events
                .push(json!({"t": "closed", "peer": id, "why": why}));
        }
        peers.retain(|_, p| p.dead.is_none());
        self.peers = peers;
    }

    /// Drain the connection's output, then write what the channel accepts: queued commands
    /// first, then the upload's bytes, then its `Completed`. str0m refuses a write while its
    /// send buffer is full; network input (the peer's acknowledgements) frees it, and the next
    /// pump writes on (nfx's bridge found that a retry loop here livelocks).
    fn pump(&mut self, id: u32, p: &mut Peer, now: Instant) {
        loop {
            loop {
                match p.rtc.poll_output() {
                    Ok(Output::Timeout(t)) => {
                        p.wake = t;
                        break;
                    }
                    Ok(Output::Transmit(t)) => {
                        let _ = self.socket.try_send_to(&t.contents, t.destination);
                    }
                    Ok(Output::Event(e)) => self.event(id, p, e, now),
                    Err(_) => {
                        p.dead = Some("rtc");
                        return;
                    }
                }
            }
            if p.dead.is_some() {
                return;
            }
            let Some(ch) = p.channel else { return };
            let next = next_write(p);
            let written = {
                let msg: &[u8] = match next {
                    Next::Nothing => return,
                    Next::Finished => {
                        cancel_upload(p, &mut self.held);
                        p.wanted = None;
                        continue;
                    }
                    Next::Command => p.out.front().map(Vec::as_slice).unwrap_or_default(),
                    Next::Body(a, b) => p
                        .upload
                        .as_ref()
                        .map(|u| &u.bytes[a..b])
                        .unwrap_or_default(),
                    Next::Tail => p
                        .upload
                        .as_ref()
                        .and_then(|u| u.tail.front())
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                };
                match p.rtc.channel(ch).map(|mut c| c.write(true, msg)) {
                    Some(Ok(w)) => w,
                    _ => {
                        p.dead = Some("write");
                        return;
                    }
                }
            };
            if !written {
                return;
            }
            p.active = now;
            match next {
                Next::Command => {
                    if let Some(m) = p.out.pop_front() {
                        p.queued -= m.len();
                    }
                }
                Next::Body(_, b) => {
                    if let Some(u) = &mut p.upload {
                        u.at = b;
                    }
                }
                Next::Tail => {
                    if let Some(u) = &mut p.upload {
                        u.tail.pop_front();
                    }
                }
                Next::Nothing | Next::Finished => {}
            }
        }
    }

    fn event(&mut self, id: u32, p: &mut Peer, e: Event, now: Instant) {
        match e {
            // One data channel per connection: a second is ignored (nfx's audit, M1).
            Event::ChannelOpen(ch, _) if p.channel.is_none() => {
                p.channel = Some(ch);
                p.active = now;
                self.events.push(json!({
                    "t": "open", "peer": id, "swarm": p.swarm,
                    "dir": if p.outgoing { "out" } else { "in" },
                }));
                let cmd = self.announcement(&p.swarm);
                queue(p, &cmd);
            }
            Event::ChannelData(d) if Some(d.id) == p.channel => {
                p.active = now;
                if !d.binary {
                    // The library sends binary messages only.
                    return;
                }
                if p2pml::is_command_chunk(&d.data) {
                    match p.joiner.feed(&d.data) {
                        Err(_) => p.dead = Some("protocol"),
                        Ok(None) => {}
                        Ok(Some(cmd)) => self.peer_command(id, p, cmd, now),
                    }
                } else {
                    self.segment_bytes(p, &d.data, now);
                }
            }
            Event::ChannelClose(ch) if Some(ch) == p.channel => p.dead = Some("closed"),
            Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                p.dead = Some("disconnected");
            }
            _ => {}
        }
    }

    fn peer_command(&mut self, id: u32, p: &mut Peer, cmd: Command, now: Instant) {
        match cmd {
            Command::Announcement { loaded, .. } => {
                p.have = loaded.into_iter().collect();
                let (ranges, more) = ranges(&p.have);
                self.events.push(json!({
                    "t": "have", "peer": id, "ranges": ranges, "more": more,
                }));
            }
            Command::Request {
                id: seg,
                request,
                from,
            } => {
                if !p.budget.take(now, PEER_BURST, PEER_RATE) {
                    p.dead = Some("flood");
                    return;
                }
                // One upload per peer: a new request replaces the one in progress.
                cancel_upload(p, &mut self.held);
                p.wanted = Some(request);
                let found = self
                    .swarms
                    .get(&p.swarm)
                    .and_then(|s| s.segments.get(&seg))
                    .cloned();
                let room = self.waiting.len() < MAX_WAITING
                    && self.budget.take(now, GLOBAL_BURST, GLOBAL_RATE);
                match found {
                    Some((path, size)) if room && from < size => {
                        self.waiting.push_back(ReadJob {
                            peer: id,
                            request,
                            id: seg,
                            from,
                            path,
                            size,
                        });
                    }
                    _ => {
                        p.wanted = None;
                        queue(p, &Command::Absent { id: seg, request });
                    }
                }
            }
            Command::Cancel { request, .. } => {
                if p.wanted == Some(request) {
                    p.wanted = None;
                    cancel_upload(p, &mut self.held);
                }
            }
            Command::Data {
                id: seg,
                request,
                size,
            } => {
                let Some(f) = &mut p.fetch else { return };
                if f.id != seg || f.request != request || f.size.is_some() {
                    return;
                }
                if size > f.max {
                    fail_fetch(
                        p,
                        "too-large",
                        "the peer's segment is larger than max",
                        true,
                    );
                    return;
                }
                f.size = Some(size);
                f.last = now;
                f.buf.reserve(usize::try_from(size).unwrap_or(0));
            }
            Command::Completed { id: seg, request } => {
                let Some(f) = &p.fetch else { return };
                if f.id != seg || f.request != request || f.size.is_none() {
                    return;
                }
                if let Some(f) = p.fetch.take() {
                    if f.size == Some(f.buf.len() as u64) {
                        let _ = f.reply.send(Ok(f.buf));
                    } else {
                        let _ = f.reply.send(Err(fail(
                            "transfer-failed",
                            "the peer sent fewer bytes than it said",
                        )));
                    }
                }
            }
            Command::Absent { id: seg, request } => {
                p.have.remove(&seg);
                if p.fetch
                    .as_ref()
                    .is_some_and(|f| f.id == seg && f.request == request)
                {
                    fail_fetch(p, "absent", "the peer does not hold that segment", false);
                }
            }
        }
    }

    fn segment_bytes(&mut self, p: &mut Peer, bytes: &[u8], now: Instant) {
        let Some(f) = &mut p.fetch else { return };
        let Some(size) = f.size else { return };
        if f.buf.len() as u64 + bytes.len() as u64 > size {
            // The library drops such a peer too.
            fail_fetch(
                p,
                "transfer-failed",
                "the peer sent more bytes than it said",
                true,
            );
            p.dead = Some("overflow");
            return;
        }
        f.buf.extend_from_slice(bytes);
        f.last = now;
    }

    fn start_reads(&mut self) {
        while self.reading < MAX_READS {
            let Some(job) = self.waiting.front() else {
                break;
            };
            let size = usize::try_from(job.size).unwrap_or(usize::MAX);
            if self.held.saturating_add(size) > MAX_HELD && self.held > 0 {
                break;
            }
            let Some(job) = self.waiting.pop_front() else {
                break;
            };
            let wanted = self
                .peers
                .get(&job.peer)
                .is_some_and(|p| p.dead.is_none() && p.wanted == Some(job.request));
            if !wanted {
                continue;
            }
            self.held += size;
            self.reading += 1;
            let done = self.done_tx.clone();
            tokio::task::spawn_blocking(move || {
                let bytes = read_exact(&job.path, job.size);
                let _ = done.blocking_send(ReadDone {
                    peer: job.peer,
                    request: job.request,
                    id: job.id,
                    from: job.from,
                    size: job.size,
                    bytes,
                });
            });
        }
    }

    fn read_done(&mut self, d: ReadDone) {
        self.reading = self.reading.saturating_sub(1);
        let size = usize::try_from(d.size).unwrap_or(usize::MAX);
        let Some(p) = self
            .peers
            .get_mut(&d.peer)
            .filter(|p| p.dead.is_none() && p.wanted == Some(d.request))
        else {
            self.held = self.held.saturating_sub(size);
            return;
        };
        let Some(bytes) = d.bytes else {
            // The file is gone or changed size: the worker named one it no longer has.
            self.held = self.held.saturating_sub(size);
            p.wanted = None;
            queue(
                p,
                &Command::Absent {
                    id: d.id,
                    request: d.request,
                },
            );
            return;
        };
        let from = usize::try_from(d.from)
            .unwrap_or(usize::MAX)
            .min(bytes.len());
        queue(
            p,
            &Command::Data {
                id: d.id,
                request: d.request,
                size: (bytes.len() - from) as u64,
            },
        );
        let tail = p2pml::encode(&Command::Completed {
            id: d.id,
            request: d.request,
        })
        .map(VecDeque::from)
        .unwrap_or_default();
        p.upload = Some(Upload {
            bytes,
            at: from,
            tail,
        });
    }
}

#[cfg(test)]
mod tests;
