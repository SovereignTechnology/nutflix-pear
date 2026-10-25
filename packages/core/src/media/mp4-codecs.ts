/**
 * RFC 6381 CODECS strings from a CMAF init segment (nfx-media `mp4.rs`): `avc1.PPCCLL` from
 * the `avcC` box, `mp4a.OO.A` from the `esds` box. ffprobe reports no profile for a bare
 * init segment (spike S4), and a CODECS string built from profile names is a guess, so the
 * bytes the decoder will be configured with are read instead. Pure; every read is
 * bounds-checked, and malformed input is a `MediaError`, never a throw of anything else.
 */
import { MediaError } from './errors.js';
import { parseBoxHeader, type Mp4Box } from './mp4-boxes.js';

/** One box directly inside a parent: its four-character type and its body (after the header). */
export interface Mp4Child {
  readonly type: string;
  readonly body: Uint8Array;
}

const bad = (what: string): MediaError => new MediaError('process-failed', `init segment: ${what}`);

/** The boxes directly inside `data`, in order. A size-0 box extends to the end of `data`. */
export function childBoxes(data: Uint8Array): readonly Mp4Child[] {
  const out: Mp4Child[] = [];
  let off = 0;
  while (off < data.length) {
    let header: Mp4Box | undefined;
    try {
      header = parseBoxHeader(data, off);
    } catch {
      throw bad('box size out of bounds'); // smaller than its own header, or past 2^53
    }
    if (header === undefined) throw bad('truncated box header');
    const size = header.size === Infinity ? data.length - off : header.size;
    if (size < header.headerSize || size > data.length - off) throw bad('box size out of bounds');
    out.push({ type: header.type, body: data.subarray(off + header.headerSize, off + size) });
    off += size;
  }
  return out;
}

function child(data: Uint8Array, type: string): Uint8Array | undefined {
  return childBoxes(data).find((b) => b.type === type)?.body;
}

function required(data: Uint8Array, type: string): Uint8Array {
  const body = child(data, type);
  if (body === undefined) throw bad(`missing '${type}' box`);
  return body;
}

/** VisualSampleEntry fields before its child boxes (ISO/IEC 14496-12 §12.1.3). */
const VISUAL_SAMPLE_ENTRY_HEADER = 78;
/** AudioSampleEntry fields before its child boxes (§12.2.3). */
const AUDIO_SAMPLE_ENTRY_HEADER = 28;

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

/** RFC 6381 CODECS strings of every track in an init segment, video first. */
export function initCodecs(init: Uint8Array): readonly string[] {
  const moov = required(init, 'moov');
  const video: string[] = [];
  const audio: string[] = [];
  for (const trak of childBoxes(moov).filter((b) => b.type === 'trak')) {
    const stbl = required(required(required(trak.body, 'mdia'), 'minf'), 'stbl');
    const stsd = required(stbl, 'stsd');
    // Full box: version/flags (4) + entry_count (4), then the sample entries.
    if (stsd.length < 8) throw bad('truncated stsd');
    const entry = childBoxes(stsd.subarray(8))[0];
    if (entry === undefined) throw bad('empty stsd');
    switch (entry.type) {
      case 'avc1':
      case 'avc3': {
        if (entry.body.length < VISUAL_SAMPLE_ENTRY_HEADER) {
          throw bad('truncated visual sample entry');
        }
        const avcc = required(entry.body.subarray(VISUAL_SAMPLE_ENTRY_HEADER), 'avcC');
        // configurationVersion, then AVCProfileIndication, profile_compatibility, AVCLevelIndication.
        if (avcc.length < 4) throw bad('truncated avcC');
        const [profile, compat, level] = [avcc[1] ?? 0, avcc[2] ?? 0, avcc[3] ?? 0];
        video.push(`${entry.type}.${hex2(profile)}${hex2(compat)}${hex2(level)}`);
        break;
      }
      case 'mp4a': {
        if (entry.body.length < AUDIO_SAMPLE_ENTRY_HEADER) {
          throw bad('truncated audio sample entry');
        }
        const esds = required(entry.body.subarray(AUDIO_SAMPLE_ENTRY_HEADER), 'esds');
        if (esds.length < 4) throw bad('truncated esds');
        audio.push(esdsCodec(esds.subarray(4)));
        break;
      }
      default:
        throw new MediaError(
          'unsupported-input',
          `init segment: sample entry '${entry.type}' (NFX packages H.264 + AAC)`,
        );
    }
  }
  if (video.length === 0) throw bad('no video track');
  return [...video, ...audio];
}

/**
 * MPEG-4 descriptors (ISO/IEC 14496-1 §8.3): a tag, then a 1–4 byte size of 7 bits each.
 * Returns the body of the first descriptor with tag `want`, or `undefined`.
 */
function findDescriptor(data: Uint8Array, want: number): Uint8Array | undefined {
  let off = 0;
  while (off < data.length) {
    const tag = data[off] ?? 0;
    off++;
    let size = 0;
    for (let i = 0; ; i++) {
      const byte = data[off];
      if (byte === undefined) throw bad('truncated descriptor size');
      off++;
      size = size * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
      if (i === 3) throw bad('descriptor size too long');
    }
    if (size > data.length - off) throw bad('descriptor overruns its box');
    const body = data.subarray(off, off + size);
    if (tag === want) return body;
    off += size;
  }
  return undefined;
}

/** `mp4a.<objectTypeIndication hex>.<audioObjectType>` from an ES_Descriptor. */
function esdsCodec(es: Uint8Array): string {
  const esDesc = findDescriptor(es, 0x03);
  if (esDesc === undefined) throw bad('no ES_Descriptor');
  const flags = esDesc[2];
  if (flags === undefined) throw bad('truncated ES_Descriptor');
  let at = 3;
  if ((flags & 0x80) !== 0) at += 2; // dependsOn_ES_ID
  if ((flags & 0x40) !== 0) {
    const urlLength = esDesc[at];
    if (urlLength === undefined) throw bad('truncated URL');
    at += 1 + urlLength;
  }
  if ((flags & 0x20) !== 0) at += 2; // OCR_ES_Id
  if (at > esDesc.length) throw bad('truncated ES_Descriptor');
  const dcd = findDescriptor(esDesc.subarray(at), 0x04);
  if (dcd === undefined) throw bad('no DecoderConfigDescriptor');
  const oti = dcd[0];
  if (oti === undefined) throw bad('truncated DecoderConfigDescriptor');
  // objectTypeIndication(1) streamType(1) bufferSizeDB(3) maxBitrate(4) avgBitrate(4)
  const dsi = dcd.length > 13 ? findDescriptor(dcd.subarray(13), 0x05) : undefined;
  const first = dsi?.[0];
  if (dsi === undefined || first === undefined) return `mp4a.${hex2(oti)}`;
  let aot = first >> 3;
  if (aot === 31) {
    const second = dsi[1];
    if (second === undefined) throw bad('truncated AudioSpecificConfig');
    aot = 32 + (((first & 0x07) << 3) | (second >> 5));
  }
  return `mp4a.${hex2(oti)}.${String(aot)}`;
}
