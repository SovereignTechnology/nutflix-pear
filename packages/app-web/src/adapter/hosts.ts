/**
 * Which hosts a URL from someone else may make this page contact: an origin or a tracker a beacon
 * names, an image a profile names. A browser cannot see where a name resolves, so this checks what
 * the URL says: an IP literal must be public unicast, and a name must not be one that only means
 * something on the viewer's own machine or network (`localhost`, `.local`, a single label, …).
 * Otherwise any relay could point every viewer's browser at their own router or a service on
 * their computer. The IP ranges are the desktop host's (`app-desktop/src/host/images/net.ts`).
 *
 * Hosts are taken as WHATWG `URL.hostname` gives them: lower-case, IPv4 in dotted form whatever
 * form the URL used (`0x7f.1` and `2130706433` are `127.0.0.1` there), IPv6 in brackets.
 */

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** [network, prefix] pairs of IPv4 space that is not the public internet. */
const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4Blocked(n: number): boolean {
  for (const [net, prefix] of V4_BLOCKED) {
    const base = v4ToInt(net) ?? 0;
    const size = 2 ** (32 - prefix);
    if (n >= base && n < base + size) return true;
  }
  return false;
}

/** An IPv6 literal (no brackets) → its 8 groups, or `null`. */
function v6Groups(ip: string): number[] | null {
  let s = ip;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[2] ?? '');
    if (n === null) return null;
    s = `${dotted[1] ?? ''}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? '');
  const tail = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function v6Blocked(g: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g6 = 0, h = 0] = g;
  const embeddedV4 = (hi: number, lo: number): boolean => v4Blocked(hi * 65536 + lo);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0) {
    if (f === 0 && g6 === 0 && (h === 0 || h === 1)) return true;
    if (f === 0xffff) return embeddedV4(g6, h);
    if (f === 0) return embeddedV4(g6, h);
  }
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return embeddedV4(g6, h);
  if (a === 0x2002) return embeddedV4(b, c);
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true;
  if (a === 0x2001 && b === 0x0db8) return true;
  if (a === 0x2001 && b < 0x200) return true;
  if ((a & 0xfe00) === 0xfc00) return true;
  if ((a & 0xffc0) === 0xfe80) return true;
  if ((a & 0xffc0) === 0xfec0) return true;
  if ((a & 0xff00) === 0xff00) return true;
  return false;
}

/** Names that only mean something on the viewer's machine or network. */
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan', '.intranet'];

/**
 * True when `hostname` (as `URL.hostname` gives it) may be contacted on someone else's say-so:
 * a public unicast IP literal, or a name with at least two labels that is not local.
 */
export function isPublicHost(hostname: string): boolean {
  if (hostname === '' || hostname.length > 253 + 2) return false;
  if (hostname.startsWith('[')) {
    if (!hostname.endsWith(']')) return false;
    const g = v6Groups(hostname.slice(1, -1));
    return g !== null && !v6Blocked(g);
  }
  if (/^[0-9.]+$/.test(hostname)) {
    const n = v4ToInt(hostname);
    return n !== null && !v4Blocked(n);
  }
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(name)) return false;
  if (name === 'localhost') return false;
  return !LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Characters a URL from someone else may not hold: whitespace and controls (which the URL parser
 * strips or rewrites silently, so the URL checked would not be the URL written) and backslashes
 * (which it reads as `/`).
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\s\\\u0000-\u001f\u007f-\u009f]/;

/**
 * `raw` parsed, when it holds no character the parser would rewrite and its authority no `@`
 * (user-info). `null` otherwise. Scheme and host rules are the caller's.
 */
export function parseStrictUrl(raw: string, maxLength: number): URL | null {
  if (raw.length > maxLength || UNSAFE.test(raw)) return null;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw);
  if (scheme === null) return null;
  const authority = raw.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? '';
  if (authority === '' || authority.includes('@')) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  return u;
}
