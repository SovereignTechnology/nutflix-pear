//! Framed stdio between the worker and the helper (README.md, "Frames").
//!
//! A frame is a 4-byte big-endian length, then that many bytes: a kind byte and its body. The
//! length is checked before a body byte is read, so a hostile length costs nothing, and a bad
//! frame is fatal: after it the stream cannot be trusted to be aligned.

use std::fmt;

use tokio::io::{AsyncRead, AsyncReadExt};

/// A JSON object: a request, a reply.
pub const KIND_CTL: u8 = 1;
/// A run of bytes answering one `get`: its request id, then the bytes.
pub const KIND_DATA: u8 = 2;
/// The largest JSON payload, and the largest run of bytes in one data frame.
pub const MAX_PAYLOAD: usize = 64 * 1024;
/// The largest frame after its length prefix: kind, request id, payload.
pub const MAX_FRAME: usize = 1 + 4 + MAX_PAYLOAD;

#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    Ctl(Vec<u8>),
    Data { id: u32, bytes: Vec<u8> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The length prefix is over [`MAX_FRAME`].
    TooLarge(u32),
    /// A zero length, or a frame with nothing after its kind byte.
    Empty,
    UnknownKind(u8),
    /// A data frame shorter than its request id.
    ShortData,
    /// The stream ended inside a frame.
    Truncated,
    Io(String),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge(n) => write!(f, "frame of {n} bytes is over {MAX_FRAME}"),
            Self::Empty => write!(f, "empty frame"),
            Self::UnknownKind(k) => write!(f, "unknown frame kind {k}"),
            Self::ShortData => write!(f, "data frame without a request id"),
            Self::Truncated => write!(f, "stream ended inside a frame"),
            Self::Io(e) => write!(f, "stdin: {e}"),
        }
    }
}

/// The body length a prefix announces, if it is one this side accepts.
pub fn check_len(len: u32) -> Result<usize, FrameError> {
    let n = usize::try_from(len).map_err(|_| FrameError::TooLarge(len))?;
    if n == 0 {
        return Err(FrameError::Empty);
    }
    if n > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    Ok(n)
}

/// A frame's body (after the prefix) as a [`Frame`].
pub fn parse_body(mut body: Vec<u8>) -> Result<Frame, FrameError> {
    let Some(&kind) = body.first() else {
        return Err(FrameError::Empty);
    };
    match kind {
        KIND_CTL => {
            if body.len() < 2 {
                return Err(FrameError::Empty);
            }
            body.remove(0);
            Ok(Frame::Ctl(body))
        }
        KIND_DATA => {
            if body.len() < 1 + 4 {
                return Err(FrameError::ShortData);
            }
            let id = u32::from_be_bytes([body[1], body[2], body[3], body[4]]);
            if body.len() == 1 + 4 {
                return Err(FrameError::Empty);
            }
            Ok(Frame::Data {
                id,
                bytes: body.split_off(1 + 4),
            })
        }
        other => Err(FrameError::UnknownKind(other)),
    }
}

fn prefixed(kind: u8, head: &[u8], payload: &[u8]) -> Vec<u8> {
    let len = 1 + head.len() + payload.len();
    let mut out = Vec::with_capacity(4 + len);
    // `len` is at most MAX_FRAME, far below u32::MAX.
    out.extend_from_slice(&u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes());
    out.push(kind);
    out.extend_from_slice(head);
    out.extend_from_slice(payload);
    out
}

/// A control frame, or `None` if the JSON is empty or over [`MAX_PAYLOAD`].
#[must_use]
pub fn encode_ctl(json: &[u8]) -> Option<Vec<u8>> {
    (!json.is_empty() && json.len() <= MAX_PAYLOAD).then(|| prefixed(KIND_CTL, &[], json))
}

/// A data frame, or `None` if `bytes` is empty or over [`MAX_PAYLOAD`].
#[must_use]
pub fn encode_data(id: u32, bytes: &[u8]) -> Option<Vec<u8>> {
    (!bytes.is_empty() && bytes.len() <= MAX_PAYLOAD)
        .then(|| prefixed(KIND_DATA, &id.to_be_bytes(), bytes))
}

/// The next frame, or `None` at a clean end of stream (between frames).
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> Result<Option<Frame>, FrameError> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < head.len() {
        let n = r
            .read(&mut head[got..])
            .await
            .map_err(|e| FrameError::Io(e.to_string()))?;
        if n == 0 {
            return if got == 0 {
                Ok(None)
            } else {
                Err(FrameError::Truncated)
            };
        }
        got += n;
    }
    let len = check_len(u32::from_be_bytes(head))?;
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            FrameError::Truncated
        } else {
            FrameError::Io(e.to_string())
        }
    })?;
    parse_body(body).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read_all(bytes: &[u8]) -> (Vec<Frame>, Option<FrameError>) {
        let mut r = bytes;
        let mut frames = Vec::new();
        loop {
            match read_frame(&mut r).await {
                Ok(Some(f)) => frames.push(f),
                Ok(None) => return (frames, None),
                Err(e) => return (frames, Some(e)),
            }
        }
    }

    #[tokio::test]
    async fn round_trips_both_kinds() {
        let mut wire = encode_ctl(br#"{"id":1,"op":"addr"}"#).unwrap();
        wire.extend(encode_data(7, &[1, 2, 3]).unwrap());
        let (frames, err) = read_all(&wire).await;
        assert_eq!(err, None);
        assert_eq!(
            frames,
            vec![
                Frame::Ctl(br#"{"id":1,"op":"addr"}"#.to_vec()),
                Frame::Data {
                    id: 7,
                    bytes: vec![1, 2, 3]
                },
            ]
        );
    }

    #[tokio::test]
    async fn refuses_an_oversize_length_before_reading_a_body() {
        let len = u32::try_from(MAX_FRAME + 1).unwrap();
        // No body follows: the prefix alone must be refused.
        let (_, err) = read_all(&len.to_be_bytes()).await;
        assert_eq!(err, Some(FrameError::TooLarge(len)));
        let (_, err) = read_all(&u32::MAX.to_be_bytes()).await;
        assert_eq!(err, Some(FrameError::TooLarge(u32::MAX)));
    }

    #[tokio::test]
    async fn the_largest_frames_pass() {
        let json = vec![b' '; MAX_PAYLOAD];
        assert!(encode_ctl(&json).is_some());
        assert!(encode_ctl(&vec![b' '; MAX_PAYLOAD + 1]).is_none());
        let data = encode_data(1, &vec![9; MAX_PAYLOAD]).unwrap();
        assert_eq!(data.len(), 4 + MAX_FRAME);
        assert!(encode_data(1, &vec![9; MAX_PAYLOAD + 1]).is_none());
        let (frames, err) = read_all(&data).await;
        assert_eq!(err, None);
        assert_eq!(frames.len(), 1);
    }

    #[tokio::test]
    async fn refuses_empty_unknown_short_and_truncated_frames() {
        assert_eq!(
            read_all(&0u32.to_be_bytes()).await.1,
            Some(FrameError::Empty)
        );
        assert_eq!(
            read_all(&[0, 0, 0, 1, KIND_CTL]).await.1,
            Some(FrameError::Empty)
        );
        assert_eq!(
            read_all(&[0, 0, 0, 2, 9, 0]).await.1,
            Some(FrameError::UnknownKind(9))
        );
        assert_eq!(
            read_all(&[0, 0, 0, 3, KIND_DATA, 0, 0]).await.1,
            Some(FrameError::ShortData)
        );
        assert_eq!(
            read_all(&[0, 0, 0, 5, KIND_DATA, 0, 0, 0, 1]).await.1,
            Some(FrameError::Empty)
        );
        assert_eq!(read_all(&[0, 0]).await.1, Some(FrameError::Truncated));
        assert_eq!(
            read_all(&[0, 0, 0, 9, KIND_CTL, b'{']).await.1,
            Some(FrameError::Truncated)
        );
    }

    #[tokio::test]
    async fn a_clean_end_between_frames_is_not_an_error() {
        assert_eq!(read_all(&[]).await, (vec![], None));
    }
}
