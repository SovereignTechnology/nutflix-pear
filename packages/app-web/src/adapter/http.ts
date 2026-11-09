/**
 * The page's own HTTP requests (NIP-11 documents and signed images): one GET with no cookies, no
 * referrer and no redirect followed (a browser does not let a page see where a redirect goes, so
 * it cannot check the next hop), a whole-request timeout, and a body read up to a cap and no
 * further.
 */

/** The part of `fetch` used here; tests pass a stub. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  override readonly name = 'HttpError' as const;
}

/**
 * GETs `url` and returns at most `maxBytes` of its body. Rejects with `HttpError` on a non-200
 * answer, a body (declared or read) over `maxBytes`, or after `timeoutMs`.
 */
export async function getBounded(
  fetchFn: FetchFn,
  url: string,
  o: {
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly accept?: string | undefined;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, o.timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ac.signal,
      ...(o.accept === undefined ? {} : { headers: { accept: o.accept } }),
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      throw new HttpError(`HTTP ${String(res.status)}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isSafeInteger(declared) && declared > o.maxBytes) {
      void res.body?.cancel().catch(() => undefined);
      throw new HttpError('too large');
    }
    return await readCapped(res, o.maxBytes);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(ac.signal.aborted ? 'timed out' : 'request failed');
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const body = res.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw new HttpError('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
