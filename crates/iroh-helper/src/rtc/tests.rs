#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tokio::net::UdpSocket;

use super::*;

fn loopback() -> Config {
    Config {
        bind: Some("127.0.0.1:0".parse().unwrap()),
        stun: Vec::new(),
        allow_private: true,
    }
}

struct Dir(PathBuf);

impl Dir {
    fn new(tag: &str) -> Self {
        let mut n = [0u8; 8];
        getrandom::fill(&mut n).unwrap();
        let hex: String = n.iter().map(|b| format!("{b:02x}")).collect();
        let d = std::env::temp_dir().join(format!("rtc-test-{tag}-{hex}"));
        std::fs::create_dir_all(&d).unwrap();
        Self(d)
    }

    fn file(&self, name: &str, bytes: &[u8]) -> Segment {
        let path = self.0.join(name);
        std::fs::write(&path, bytes).unwrap();
        Segment {
            id: 0,
            path,
            size: bytes.len() as u64,
        }
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Bytes that would frame as commands at many natural cuts, and some that would not.
fn awkward(len: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(len);
    let mut i = 0u32;
    while v.len() < len {
        v.extend_from_slice(b"cstr");
        v.extend_from_slice(&i.to_be_bytes());
        v.extend_from_slice(b"cend");
        v.extend_from_slice(&[(i % 251) as u8; 37]);
        i += 1;
    }
    v.truncate(len);
    v
}

/// Poll `h` until an event matching `want` arrives (events before it are dropped).
async fn wait_for(h: &RtcHandle, want: impl Fn(&Value) -> bool) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!left.is_zero(), "no matching event in 20 s");
        let (events, _) = h
            .poll(left.min(Duration::from_secs(2)), 60_000)
            .await
            .unwrap();
        if let Some(e) = events.into_iter().find(|e| want(e)) {
            return e;
        }
    }
}

fn is(t: &str, peer: u32) -> impl Fn(&Value) -> bool + '_ {
    move |e| e["t"] == t && e["peer"] == peer
}

/// A connects to B: A offers, B answers, A accepts. Returns (A's peer id, B's peer id).
async fn connect(a: &RtcHandle, b: &RtcHandle, swarm: &str) -> (u32, u32) {
    let offer = a.offer(swarm.into()).await.unwrap();
    let answer = b.answer(swarm.into(), offer.sdp).await.unwrap();
    a.accept(offer.peer, answer.sdp).await.unwrap();
    (offer.peer, answer.peer)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_shaped_peer_fetches_what_is_served() {
    let dir = Dir::new("serve");
    let seeder = RtcHandle::start(loopback()).await.unwrap();
    let viewer = RtcHandle::start(loopback()).await.unwrap();
    let swarm = "nfx/1/web/nfx:testnet:1:clip/720p";

    let body = awkward(300 * 1024 + 7);
    let mut s0 = dir.file("s0", &body);
    s0.id = 0;
    let mut s3 = dir.file("s3", b"tiny");
    s3.id = 3;
    assert_eq!(
        seeder.serve(swarm.into(), vec![s0], false).await.unwrap(),
        1
    );
    assert_eq!(seeder.serve(swarm.into(), vec![s3], true).await.unwrap(), 2);

    // The viewer dials the seeder, as a browser answering nobody but offering would.
    let (v_peer, s_peer) = connect(&viewer, &seeder, swarm).await;
    let open = wait_for(&viewer, is("open", v_peer)).await;
    assert_eq!(open["dir"], "out");
    assert_eq!(open["swarm"], swarm);
    let have = wait_for(&viewer, is("have", v_peer)).await;
    assert_eq!(have["ranges"], serde_json::json!([[0, 0], [3, 3]]));
    let open = wait_for(&seeder, is("open", s_peer)).await;
    assert_eq!(open["dir"], "in");

    let got = viewer.get(v_peer, 0, MAX_SEGMENT).await.unwrap();
    assert_eq!(got.len(), body.len());
    assert!(got == body, "bytes differ");
    assert_eq!(viewer.get(v_peer, 3, 1024).await.unwrap(), b"tiny");

    // Not served: absent. Larger than max: too-large.
    assert_eq!(
        viewer.get(v_peer, 1, 1024).await.unwrap_err().code,
        "absent"
    );
    assert_eq!(
        viewer.get(v_peer, 0, 1000).await.unwrap_err().code,
        "too-large"
    );

    // A file that changed size since it was named is never sent.
    std::fs::write(dir.0.join("s3"), b"tinier").unwrap();
    assert_eq!(
        viewer.get(v_peer, 3, 1024).await.unwrap_err().code,
        "absent"
    );

    // Serving more re-announces it.
    let mut s5 = dir.file("s5", b"five");
    s5.id = 5;
    seeder.serve(swarm.into(), vec![s5], true).await.unwrap();
    let have = wait_for(&viewer, |e| {
        e["t"] == "have"
            && e["peer"] == v_peer
            && e["ranges"].as_array().is_some_and(|r| r.len() == 3)
    })
    .await;
    assert_eq!(have["ranges"], serde_json::json!([[0, 0], [3, 3], [5, 5]]));

    // Either side may fetch: the seeder asks the viewer, which serves nothing.
    assert_eq!(
        seeder.get(s_peer, 0, 1024).await.unwrap_err().code,
        "absent"
    );

    // Hanging up closes it here at once.
    assert!(viewer.hangup(v_peer).await.unwrap());
    let closed = wait_for(&viewer, is("closed", v_peer)).await;
    assert_eq!(closed["why"], "hangup");
    assert_eq!(
        viewer.get(v_peer, 0, 1024).await.unwrap_err().code,
        "no-peer"
    );

    viewer.stop().await;
    seeder.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn requests_are_checked_and_bounded() {
    let h = RtcHandle::start(loopback()).await.unwrap();
    let swarm = "nfx/1/web/x:y/r";
    assert_eq!(
        h.answer(swarm.into(), "not sdp".into())
            .await
            .unwrap_err()
            .code,
        "bad-request"
    );
    assert_eq!(
        h.answer("".into(), "v=0".into()).await.unwrap_err().code,
        "bad-request"
    );
    assert_eq!(
        h.answer(swarm.into(), "x".repeat(MAX_SDP + 1))
            .await
            .unwrap_err()
            .code,
        "bad-request"
    );
    assert_eq!(h.get(1, 0, 0).await.unwrap_err().code, "bad-request");
    assert_eq!(h.get(1, 0, 1).await.unwrap_err().code, "no-peer");
    assert_eq!(h.accept(1, "v=0".into()).await.unwrap_err().code, "no-peer");
    let relative = Segment {
        id: 0,
        path: "relative".into(),
        size: 1,
    };
    assert_eq!(
        h.serve(swarm.into(), vec![relative], false)
            .await
            .unwrap_err()
            .code,
        "bad-request"
    );

    // At most MAX_PER_SWARM connections in one swarm.
    for _ in 0..MAX_PER_SWARM {
        h.offer(swarm.into()).await.unwrap();
    }
    assert_eq!(h.offer(swarm.into()).await.unwrap_err().code, "busy");
    // Another swarm still has room.
    let other = h.offer("nfx/1/web/x:y/r2".into()).await.unwrap();
    assert!(other.candidates >= 1);
    // An offer waiting for its answer is not open: no fetch yet.
    assert_eq!(h.get(other.peer, 0, 1).await.unwrap_err().code, "not-open");
    // One poll at a time.
    let (a, b) = tokio::join!(
        h.poll(Duration::from_millis(300), 1000),
        h.poll(Duration::from_millis(300), 1000)
    );
    assert!(a.is_err() != b.is_err(), "exactly one poll is refused");
    h.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_public_mapping_comes_from_stun() {
    // A STUN server on loopback that reports a public-looking address.
    let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let at = server.local_addr().unwrap();
    // Global, so it is shown (a documentation address would be filtered like a private one).
    let public: SocketAddr = "1.2.3.4:40000".parse().unwrap();
    let srv = tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let Ok((n, from)) = server.recv_from(&mut buf).await else {
                return;
            };
            if n >= 20 && buf[0..2] == [0, 1] {
                let tx: stun::TxId = buf[8..20].try_into().unwrap();
                let r = stun::tests::response(&tx, public, None);
                let _ = server.send_to(&r, from).await;
            }
        }
    });
    let h = RtcHandle::start(Config {
        bind: Some("127.0.0.1:0".parse().unwrap()),
        stun: vec![at.to_string()],
        allow_private: false,
    })
    .await
    .unwrap();
    assert_eq!(h.mapped, Some(public));
    let status = h.status().await.unwrap();
    assert_eq!(status["mapped"], public.to_string());

    // Without allow_private the loopback host is kept out of what is shown; the mapping is
    // the one candidate.
    let offer = h.offer("nfx/1/web/a:b/c".into()).await.unwrap();
    assert_eq!(offer.candidates, 1);
    assert!(offer.sdp.contains("1.2.3.4 40000 typ srflx"));
    assert!(!offer.sdp.contains("127.0.0.1"));
    h.stop().await;
    srv.abort();
}

#[tokio::test]
async fn start_needs_an_address() {
    let err = RtcHandle::start(Config {
        bind: None,
        stun: Vec::new(),
        allow_private: false,
    })
    .await
    .err()
    .unwrap();
    assert_eq!(err.code, "bad-request");
    let five = (0..5).map(|i| format!("127.0.0.1:{}", 3478 + i)).collect();
    let err = RtcHandle::start(Config {
        bind: Some("127.0.0.1:0".parse().unwrap()),
        stun: five,
        allow_private: true,
    })
    .await
    .err()
    .unwrap();
    assert_eq!(err.code, "bad-request");
}

#[test]
fn ranges_and_announcements_are_bounded() {
    let ids: BTreeSet<u64> = [0, 1, 2, 5, 7, 8].into_iter().collect();
    assert_eq!(ranges(&ids), (vec![[0, 2], [5, 5], [7, 8]], false));
    let many: BTreeSet<u64> = (0..2000).map(|i| i * 2).collect();
    let (r, more) = ranges(&many);
    assert_eq!(r.len(), MAX_RANGES);
    assert!(more);
    let ids = announceable((0..300 * 256).map(|i| i as u64));
    assert_eq!(ids.len(), 255 * 256);
}
