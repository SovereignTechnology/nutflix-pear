/**
 * Canonical JSON (`canon`, NFX-11 §9): the serialization NFX-defined signed objects (gossip
 * envelopes, vouchers) are hashed in. Received text is parsed by the strict reader, and what
 * the rule calls non-canonicalizable (fractions, exponents, `-0`, integers outside
 * ±(2^53 − 1), duplicate keys, lone surrogates) is **rejected**, never normalized.
 */
import { JsonNumber, isJsonArray, parseJson, type JsonObject, type JsonValue } from './json.js';
import { fail, ok, type NfxResult } from './errors.js';
import { compareCodePoints } from './util.js';

/** Largest magnitude of an integer `canon` accepts (2^53 − 1). */
export const MAX_SAFE_INT = 9_007_199_254_740_991n;

/** `canon(parse(text))`: the canonical form of received text, or why it has none. */
export function canonicalize(text: string): NfxResult<string> {
  const parsed = parseJson(text);
  if (!parsed.ok) return fail('canon', parsed.error);
  return canonOf(parsed.value);
}

/** The canonical text of a parsed value. */
export function canonOf(value: JsonValue): NfxResult<string> {
  const out: string[] = [];
  const reason = write(out, value);
  return reason === undefined ? ok(out.join('')) : fail('canon', reason);
}

function write(out: string[], value: JsonValue): string | undefined {
  if (value === null || typeof value === 'boolean') {
    out.push(String(value));
  } else if (typeof value === 'string') {
    // JSON.stringify escapes exactly canon's set for a well-formed string: `"`, `\`, the
    // two-letter controls and `\u00xx` (lowercase) below U+0020, nothing else.
    out.push(JSON.stringify(value));
  } else if (value instanceof JsonNumber) {
    if (value.int === undefined) return `non-integer number: ${value.text}`;
    if (value.int > MAX_SAFE_INT || value.int < -MAX_SAFE_INT) {
      return `integer out of range: ${value.text}`;
    }
    out.push(value.int.toString());
  } else if (isJsonArray(value)) {
    out.push('[');
    for (const [i, item] of value.entries()) {
      if (i > 0) out.push(',');
      const reason = write(out, item);
      if (reason !== undefined) return reason;
    }
    out.push(']');
  } else {
    return writeObject(out, value);
  }
  return undefined;
}

function writeObject(out: string[], value: JsonObject): string | undefined {
  if (value.duplicates.size > 0) {
    return `duplicate key ${JSON.stringify([...value.duplicates][0] ?? '')}`;
  }
  const keys = [...value.entries.keys()].sort(compareCodePoints);
  out.push('{');
  for (const [i, key] of keys.entries()) {
    if (i > 0) out.push(',');
    out.push(JSON.stringify(key), ':');
    const reason = write(out, value.entries.get(key) ?? null);
    if (reason !== undefined) return reason;
  }
  out.push('}');
  return undefined;
}
