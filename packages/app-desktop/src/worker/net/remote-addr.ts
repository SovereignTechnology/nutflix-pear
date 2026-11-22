/**
 * Pear #123 (ADR 0024): a peer's address as stats for nerds shows it: `a.b.c.d:port` or
 * `[v6]:port`, lowercase and without a scope, or `''` when the transport gives nothing usable.
 *
 * These are other hosts' IP addresses. They are computed only inside an `addresses` call, go back
 * only as its answer, and never reach a logger (the worker's logger takes indexes and reason codes
 * only).
 */

const V4 = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/;
const V6 = /^[0-9a-f:.]{2,45}$/;

function isV4(h: string): boolean {
  const m = V4.exec(h);
  if (m === null) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** `host` and `port` as one address, or `''`. */
export function hostPort(host: unknown, port: unknown): string {
  if (typeof host !== 'string' || host.length > 64) return '';
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const scope = h.indexOf('%');
  if (scope >= 0) h = h.slice(0, scope);
  if (isV4(h)) return `${h}:${String(port)}`;
  if (h.includes(':') && V6.test(h)) return `[${h}]:${String(port)}`;
  return '';
}

/** An `ip:port` as the helper prints one (Rust's `SocketAddr`), in the form above, or `''`. */
export function socketAddr(s: unknown): string {
  if (typeof s !== 'string' || s.length > 64) return '';
  const m = /^(\[[^\]]+\]|[0-9.]+):([0-9]{1,5})$/.exec(s);
  return m === null ? '' : hostPort(m[1], Number(m[2]));
}

function read(o: unknown, k: string): unknown {
  if (typeof o !== 'object' || o === null) return undefined;
  try {
    return (o as Readonly<Record<string, unknown>>)[k];
  } catch {
    return undefined;
  }
}

/**
 * Where a Holepunch connection (a `@hyperswarm/secret-stream`) goes: its UDX raw stream's
 * `remoteHost` and `remotePort`, or `''`. Neither Hyperswarm nor HyperDHT relays here (no
 * `relayThrough` is configured), so it is the peer's own address or its NAT's mapping.
 */
export function streamRemote(stream: unknown): string {
  const raw = read(stream, 'rawStream');
  return hostPort(read(raw, 'remoteHost'), read(raw, 'remotePort'));
}
