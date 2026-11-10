//! The peer protocol browsers speak over an NFX web swarm's data channel: p2p-media-loader
//! 4.0.0's own binary commands (NFX-10 names the library and pins the version, NFX-11 §4; it
//! defines no bytes of its own). Written from the library's source
//! (`p2p-media-loader-core/src/p2p/commands/`), not from another NFX implementation (ADR 0023).
//!
//! A message on the channel is either a command chunk (it starts with `cstr` or `dstr` and ends
//! with `cend` or `dend`) or raw bytes of the segment being sent. A command is one byte of type,
//! then `(name: u8, item)*`. Items are an integer (`0x0N` then N big-endian bytes, the top bit of
//! the first byte a sign), an array of integers grouped by their high bits (`0x10`), or a string
//! (`0x2L`, which 4.0.0 never sends but can parse). A command longer than one message is split
//! into chunks of equal length: `cstr…dend`, `dstr…dend`, …, `dstr…cend`.

use std::fmt;

/// The library's `webRtcMaxMessageSize` default: no message it sends, and none we send, is longer.
pub const MAX_MESSAGE: usize = 64 * 1024 - 1;
/// The largest integer JavaScript represents exactly (the library's limit of 7 bytes).
pub const MAX_INT: u64 = (1 << 53) - 1;
/// An announcement's array holds at most 255 groups (its count is one byte) of 256 ids.
pub const MAX_GROUPS: usize = 255;
/// A command being joined from chunks may not grow past this: an announcement of every id the
/// format allows is about 66 KiB, so 256 KiB leaves room and stops a peer from growing it forever.
pub const MAX_JOINED: usize = 256 * 1024;

const FRAME: usize = 4;
const CSTR: &[u8; 4] = b"cstr";
const CEND: &[u8; 4] = b"cend";
const DSTR: &[u8; 4] = b"dstr";
const DEND: &[u8; 4] = b"dend";

const ITEM_INT: u8 = 0;
const ITEM_ARRAY: u8 = 1;
const ITEM_STRING: u8 = 2;

const ANNOUNCEMENT: u8 = 0;
const REQUEST: u8 = 1;
const DATA: u8 = 2;
const COMPLETED: u8 = 3;
const ABSENT: u8 = 4;
const CANCEL: u8 = 5;

/// One command. `id` is a segment's position in its rendition's playlist (NFX-10 §2), `request`
/// the asker's number for this request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    /// The segments the sender holds (`l`) and the ones it is loading over HTTP (`p`).
    Announcement { loaded: Vec<u64>, loading: Vec<u64> },
    /// Send me segment `id`, from byte `from` on.
    Request { id: u64, request: u64, from: u64 },
    /// `size` bytes of segment `id` follow as raw messages.
    Data { id: u64, request: u64, size: u64 },
    /// All of the data for `request` has been sent.
    Completed { id: u64, request: u64 },
    /// I do not hold segment `id`.
    Absent { id: u64, request: u64 },
    /// Stop sending for `request`.
    Cancel { id: u64, request: u64 },
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// An integer is above [`MAX_INT`], negative, or of a length the format does not allow.
    Int,
    /// An announcement needs more than [`MAX_GROUPS`] groups.
    TooManyGroups,
    /// The bytes end inside an item.
    Truncated,
    /// An item type the format does not define.
    UnknownItem,
    /// A command type the library does not define.
    UnknownCommand,
    /// A field the command needs is missing or is not an integer.
    MissingField(char),
    /// A chunk that is not where the framing says it may be.
    Framing,
    /// A command larger than [`MAX_JOINED`].
    TooLarge,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Int => f.write_str("integer out of range"),
            Self::TooManyGroups => f.write_str("more than 255 groups of ids"),
            Self::Truncated => f.write_str("truncated command"),
            Self::UnknownItem => f.write_str("unknown item type"),
            Self::UnknownCommand => f.write_str("unknown command type"),
            Self::MissingField(c) => write!(f, "missing integer field {c:?}"),
            Self::Framing => f.write_str("command chunks out of order"),
            Self::TooLarge => f.write_str("command too large"),
        }
    }
}

/// Whether `msg` is a command chunk rather than segment bytes: the library's `isCommandChunk`.
#[must_use]
pub fn is_command_chunk(msg: &[u8]) -> bool {
    msg.len() >= 2 * FRAME
        && (msg.starts_with(CSTR) || msg.starts_with(DSTR))
        && (msg.ends_with(CEND) || msg.ends_with(DEND))
}

/// The library's `getRequiredBytesForInt`: enough bytes for the magnitude and a sign bit.
fn int_len(n: u64) -> usize {
    if n == 0 {
        return 1;
    }
    let bits = 64 - n.leading_zeros() as usize; // floor(log2 n) + 1
    (bits + 1).div_ceil(8)
}

fn put_int(out: &mut Vec<u8>, n: u64) -> Result<(), Error> {
    if n > MAX_INT {
        return Err(Error::Int);
    }
    let len = int_len(n);
    out.push((ITEM_INT << 4) | len as u8);
    out.extend_from_slice(&n.to_be_bytes()[8 - len..]);
    Ok(())
}

/// The library's `serializeUniqueSimilarIntArray`, ids taken in ascending order with
/// duplicates dropped: one group per block of 256, each a header integer (the block's base plus
/// its count, mod 256) and one low byte per id.
fn put_array(out: &mut Vec<u8>, ids: &[u64]) -> Result<(), Error> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut groups: Vec<(u64, Vec<u8>)> = Vec::new();
    for id in ids {
        if id > MAX_INT {
            return Err(Error::Int);
        }
        let base = id & !0xff;
        match groups.last_mut() {
            Some((b, low)) if *b == base => low.push((id & 0xff) as u8),
            _ => groups.push((base, vec![(id & 0xff) as u8])),
        }
    }
    if groups.len() > MAX_GROUPS {
        return Err(Error::TooManyGroups);
    }
    out.push(ITEM_ARRAY << 4);
    out.push(groups.len() as u8);
    for (base, low) in groups {
        // A full block of 256 writes a count of 0, which the reader takes as 256.
        put_int(out, base + (low.len() as u64 & 0xff))?;
        out.extend_from_slice(&low);
    }
    Ok(())
}

fn body(cmd: &Command) -> Result<Vec<u8>, Error> {
    let mut b = Vec::with_capacity(32);
    let field = |b: &mut Vec<u8>, name: u8, n: u64| {
        b.push(name);
        put_int(b, n)
    };
    match cmd {
        Command::Announcement { loaded, loading } => {
            b.push(ANNOUNCEMENT);
            if !loaded.is_empty() {
                b.push(b'l');
                put_array(&mut b, loaded)?;
            }
            if !loading.is_empty() {
                b.push(b'p');
                put_array(&mut b, loading)?;
            }
        }
        Command::Request { id, request, from } => {
            b.push(REQUEST);
            field(&mut b, b'i', *id)?;
            field(&mut b, b'r', *request)?;
            if *from != 0 {
                field(&mut b, b'b', *from)?;
            }
        }
        Command::Data { id, request, size } => {
            b.push(DATA);
            field(&mut b, b'i', *id)?;
            field(&mut b, b's', *size)?;
            field(&mut b, b'r', *request)?;
        }
        Command::Completed { id, request } => {
            b.push(COMPLETED);
            field(&mut b, b'i', *id)?;
            field(&mut b, b'r', *request)?;
        }
        Command::Absent { id, request } => {
            b.push(ABSENT);
            field(&mut b, b'i', *id)?;
            field(&mut b, b'r', *request)?;
        }
        Command::Cancel { id, request } => {
            b.push(CANCEL);
            field(&mut b, b'i', *id)?;
            field(&mut b, b'r', *request)?;
        }
    }
    Ok(b)
}

fn framed(start: &[u8; 4], part: &[u8], end: &[u8; 4]) -> Vec<u8> {
    let mut m = Vec::with_capacity(part.len() + 2 * FRAME);
    m.extend_from_slice(start);
    m.extend_from_slice(part);
    m.extend_from_slice(end);
    m
}

/// `cmd` as the messages to send, in order: the library's `BinaryCommandCreator.complete`.
pub fn encode(cmd: &Command) -> Result<Vec<Vec<u8>>, Error> {
    encode_with(cmd, MAX_MESSAGE)
}

fn encode_with(cmd: &Command, max: usize) -> Result<Vec<Vec<u8>>, Error> {
    let b = body(cmd)?;
    if b.len() + 2 * FRAME <= max {
        return Ok(vec![framed(CSTR, &b, CEND)]);
    }
    let mut count = b.len().div_ceil(max);
    if b.len().div_ceil(count) + 2 * FRAME > max {
        count += 1;
    }
    let len = b.len().div_ceil(count);
    Ok((0..count)
        .map(|i| {
            let part = b.get(i * len..((i + 1) * len).min(b.len())).unwrap_or(&[]);
            let start = if i == 0 { CSTR } else { DSTR };
            let end = if i == count - 1 { CEND } else { DEND };
            framed(start, part, end)
        })
        .collect())
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, Error> {
        let v = *self.b.get(self.at).ok_or(Error::Truncated)?;
        self.at += 1;
        Ok(v)
    }

    fn take(&mut self, n: usize) -> Result<&[u8], Error> {
        let s = self.b.get(self.at..self.at + n).ok_or(Error::Truncated)?;
        self.at += n;
        Ok(s)
    }

    fn int(&mut self) -> Result<u64, Error> {
        let meta = self.byte()?;
        if meta >> 4 != ITEM_INT {
            return Err(Error::UnknownItem);
        }
        let len = usize::from(meta & 0x0f);
        if len == 0 || len > 7 {
            return Err(Error::Int);
        }
        let bytes = self.take(len)?;
        if bytes[0] & 0x80 != 0 {
            // A negative number: no field we read may be one.
            return Err(Error::Int);
        }
        let n = bytes.iter().fold(0u64, |n, &x| (n << 8) | u64::from(x));
        if n > MAX_INT {
            return Err(Error::Int);
        }
        Ok(n)
    }

    fn array(&mut self) -> Result<Vec<u64>, Error> {
        let _code = self.byte()?;
        let groups = self.byte()?;
        let mut ids = Vec::new();
        for _ in 0..groups {
            let head = self.int()?;
            let count = match head & 0xff {
                0 => 256,
                n => n as usize,
            };
            let base = head - (head & 0xff);
            ids.extend(self.take(count)?.iter().map(|&low| base + u64::from(low)));
        }
        Ok(ids)
    }

    fn string(&mut self) -> Result<(), Error> {
        let hi = self.byte()?;
        let lo = self.byte()?;
        let len = (usize::from(hi & 0x0f) << 8) | usize::from(lo);
        self.take(len).map(|_| ())
    }
}

#[derive(Default)]
struct Fields {
    ints: [Option<u64>; 4], // i r s b
    loaded: Vec<u64>,
    loading: Vec<u64>,
}

/// One whole command (its chunks joined, frames removed): the library's `deserializeCommand`.
/// Fields of other names are read and ignored, as the library keeps but never uses them.
pub fn decode(b: &[u8]) -> Result<Command, Error> {
    let mut r = Reader { b, at: 0 };
    let kind = r.byte()?;
    let mut f = Fields::default();
    while r.at < b.len() {
        if r.at + 1 >= b.len() {
            return Err(Error::Truncated);
        }
        let name = r.byte()?;
        let item = *b.get(r.at).ok_or(Error::Truncated)? >> 4;
        let slot = match name {
            b'i' => Some(0),
            b'r' => Some(1),
            b's' => Some(2),
            b'b' => Some(3),
            _ => None,
        };
        match item {
            ITEM_INT => {
                let n = r.int()?;
                if let Some(s) = slot {
                    f.ints[s] = Some(n);
                }
            }
            ITEM_ARRAY => {
                let ids = r.array()?;
                match name {
                    b'l' => f.loaded = ids,
                    b'p' => f.loading = ids,
                    _ => {}
                }
            }
            ITEM_STRING => r.string()?,
            _ => return Err(Error::UnknownItem),
        }
    }
    let need = |s: usize, c: char| f.ints[s].ok_or(Error::MissingField(c));
    Ok(match kind {
        ANNOUNCEMENT => Command::Announcement {
            loaded: f.loaded,
            loading: f.loading,
        },
        REQUEST => Command::Request {
            id: need(0, 'i')?,
            request: need(1, 'r')?,
            from: f.ints[3].unwrap_or(0),
        },
        DATA => Command::Data {
            id: need(0, 'i')?,
            request: need(1, 'r')?,
            size: need(2, 's')?,
        },
        COMPLETED => Command::Completed {
            id: need(0, 'i')?,
            request: need(1, 'r')?,
        },
        ABSENT => Command::Absent {
            id: need(0, 'i')?,
            request: need(1, 'r')?,
        },
        CANCEL => Command::Cancel {
            id: need(0, 'i')?,
            request: need(1, 'r')?,
        },
        _ => return Err(Error::UnknownCommand),
    })
}

/// Joins a command's chunks: the library's `BinaryCommandChunksJoiner`. A command starts with a
/// `cstr` chunk and ends with a `cend` one; a `cstr` while one is being joined is an error.
#[derive(Default)]
pub struct Joiner {
    buf: Vec<u8>,
    open: bool,
}

impl Joiner {
    /// Feed one command chunk (one that [`is_command_chunk`] accepts). `Some` once a command is
    /// whole.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Option<Command>, Error> {
        if chunk.len() < 2 * FRAME {
            return Err(Error::Framing);
        }
        let first = chunk.starts_with(CSTR);
        if first == self.open {
            // A continuation with nothing open, or a new command while one is open.
            self.reset();
            return Err(Error::Framing);
        }
        self.open = true;
        let part = &chunk[FRAME..chunk.len() - FRAME];
        if self.buf.len() + part.len() > MAX_JOINED {
            self.reset();
            return Err(Error::TooLarge);
        }
        self.buf.extend_from_slice(part);
        if !chunk.ends_with(CEND) {
            return Ok(None);
        }
        let whole = std::mem::take(&mut self.buf);
        self.open = false;
        decode(&whole).map(Some)
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.open = false;
    }
}

/// Where to cut segment data into messages of at most `max` bytes such that no message looks
/// like a command chunk (the reader would take it for one and fail the peer). A cut that would
/// look like one is moved one byte earlier until it does not; a piece shorter than 8 bytes never
/// does. The engine applies the same rule one message at a time (`rtc::next_write`).
#[cfg(test)]
#[must_use]
pub fn data_cuts(data: &[u8], max: usize) -> Vec<(usize, usize)> {
    let max = max.max(1);
    let mut cuts = Vec::with_capacity(data.len() / max + 1);
    let mut at = 0;
    while at < data.len() {
        let mut end = (at + max).min(data.len());
        while end - at > 1 && is_command_chunk(&data[at..end]) {
            end -= 1;
        }
        cuts.push((at, end));
        at = end;
    }
    cuts
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn int_lengths_match_the_library() {
        // getRequiredBytesForInt: floor(log2 n) + 2 bits, in bytes.
        for (n, len) in [
            (0, 1),
            (1, 1),
            (127, 1),
            (128, 2),
            (255, 2),
            (32767, 2),
            (32768, 3),
            (MAX_INT, 7),
        ] {
            assert_eq!(int_len(n), len, "{n}");
        }
    }

    #[test]
    fn a_request_is_framed_once() {
        let m = encode(&Command::Request {
            id: 42,
            request: 7,
            from: 0,
        })
        .unwrap();
        // "cstr" 01 'i' Int(42) 'r' Int(7) "cend"
        assert_eq!(hex(&m[0]), "637374720169012a72010763656e64");
        assert!(is_command_chunk(&m[0]));
    }

    #[test]
    fn every_command_round_trips() {
        let all = [
            Command::Announcement {
                loaded: vec![0, 1, 2, 255, 256, 300, 70_000],
                loading: vec![5],
            },
            Command::Announcement {
                loaded: vec![],
                loading: vec![],
            },
            Command::Request {
                id: 3,
                request: 999_999_999,
                from: 4096,
            },
            Command::Data {
                id: 3,
                request: 1,
                size: 64 * 1024 * 1024,
            },
            Command::Completed { id: 3, request: 1 },
            Command::Absent { id: 3, request: 1 },
            Command::Cancel { id: 3, request: 1 },
        ];
        for cmd in all {
            let mut j = Joiner::default();
            let msgs = encode(&cmd).unwrap();
            let mut out = None;
            for m in &msgs {
                assert!(is_command_chunk(m));
                out = j.feed(m).unwrap();
            }
            assert_eq!(out.unwrap(), cmd);
        }
    }

    #[test]
    fn a_full_block_is_written_with_count_zero() {
        let loaded: Vec<u64> = (256..512).collect();
        let m = encode(&Command::Announcement {
            loaded: loaded.clone(),
            loading: vec![],
        })
        .unwrap();
        // header int is 256 + (256 & 0xff) = 256: two bytes 01 00
        assert_eq!(&m[0][4..10], &[0, b'l', 0x10, 1, 0x02, 0x01]);
        assert_eq!(&m[0][10..11], &[0x00]);
        let mut j = Joiner::default();
        assert_eq!(
            j.feed(&m[0]).unwrap().unwrap(),
            Command::Announcement {
                loaded,
                loading: vec![]
            }
        );
    }

    #[test]
    fn long_commands_split_like_the_library() {
        // 255 full blocks: 1 + 1 + 2 + 255 * (3 + 256) bytes, far above one message.
        let loaded: Vec<u64> = (0..255 * 256).collect();
        let cmd = Command::Announcement {
            loaded,
            loading: vec![],
        };
        let msgs = encode(&cmd).unwrap();
        assert!(msgs.len() >= 2);
        assert!(msgs.iter().all(|m| m.len() <= MAX_MESSAGE));
        assert!(msgs[0].starts_with(CSTR) && msgs[0].ends_with(DEND));
        let last = msgs.last().unwrap();
        assert!(last.starts_with(DSTR) && last.ends_with(CEND));
        let mut j = Joiner::default();
        let mut out = None;
        for m in &msgs {
            out = j.feed(m).unwrap();
        }
        assert_eq!(out.unwrap(), cmd);
        // A small limit forces many equal parts, the last possibly empty.
        let msgs = encode_with(
            &Command::Request {
                id: 1,
                request: 2,
                from: 3,
            },
            9,
        )
        .unwrap();
        assert!(msgs.len() > 2);
        let mut j = Joiner::default();
        let mut out = None;
        for m in &msgs {
            out = j.feed(m).unwrap();
        }
        assert_eq!(
            out.unwrap(),
            Command::Request {
                id: 1,
                request: 2,
                from: 3
            }
        );
    }

    #[test]
    fn more_than_255_blocks_is_refused() {
        let loaded: Vec<u64> = (0..256).map(|b| b * 256).collect();
        assert_eq!(
            encode(&Command::Announcement {
                loaded,
                loading: vec![]
            }),
            Err(Error::TooManyGroups)
        );
    }

    #[test]
    fn bad_input_is_refused() {
        // Unknown command type.
        assert_eq!(decode(&[9]), Err(Error::UnknownCommand));
        // Request without r.
        assert_eq!(decode(&[1, b'i', 0x01, 5]), Err(Error::MissingField('r')));
        // Negative integer.
        assert_eq!(
            decode(&[1, b'i', 0x01, 0x85, b'r', 0x01, 1]),
            Err(Error::Int)
        );
        // Eight-byte integer.
        assert_eq!(
            decode(&[1, b'i', 0x08, 0, 0, 0, 0, 0, 0, 0, 1]),
            Err(Error::Int)
        );
        // Item type 3.
        assert_eq!(decode(&[1, b'i', 0x31, 5]), Err(Error::UnknownItem));
        // Truncated header and truncated array.
        assert_eq!(decode(&[1, b'i']), Err(Error::Truncated));
        assert_eq!(
            decode(&[0, b'l', 0x10, 1, 0x01, 3, 1]),
            Err(Error::Truncated)
        );
        // A string field is read and ignored.
        assert_eq!(
            decode(&[3, b'x', 0x20, 2, b'h', b'i', b'i', 0x01, 1, b'r', 0x01, 2]),
            Ok(Command::Completed { id: 1, request: 2 })
        );
    }

    #[test]
    fn framing_out_of_order_is_refused() {
        let mut j = Joiner::default();
        assert_eq!(j.feed(b"dstrxxcend"), Err(Error::Framing));
        let mut j = Joiner::default();
        assert_eq!(j.feed(b"cstr\x01dend").unwrap(), None);
        assert_eq!(j.feed(b"cstr\x01cend"), Err(Error::Framing));
    }

    #[test]
    fn a_joined_command_is_bounded() {
        let mut j = Joiner::default();
        let part = vec![0u8; 60 * 1024];
        let mut first = b"cstr".to_vec();
        first.extend_from_slice(&part);
        first.extend_from_slice(b"dend");
        assert_eq!(j.feed(&first).unwrap(), None);
        let mut mid = b"dstr".to_vec();
        mid.extend_from_slice(&part);
        mid.extend_from_slice(b"dend");
        let mut result = Ok(None);
        for _ in 0..8 {
            result = j.feed(&mid);
            if result.is_err() {
                break;
            }
        }
        assert_eq!(result, Err(Error::TooLarge));
    }

    #[test]
    fn data_never_looks_like_a_command() {
        // A segment whose bytes would frame as commands at every natural cut.
        let mut data = Vec::new();
        for _ in 0..4 {
            data.extend_from_slice(b"cstr");
            data.extend_from_slice(&[7u8; 16]);
            data.extend_from_slice(b"cend");
        }
        let cuts = data_cuts(&data, 24);
        let mut joined = Vec::new();
        for (a, b) in &cuts {
            assert!(b - a <= 24 && b > a);
            assert!(!is_command_chunk(&data[*a..*b]));
            joined.extend_from_slice(&data[*a..*b]);
        }
        assert_eq!(joined, data);
        assert!(data_cuts(&[], 16).is_empty());
    }
}
