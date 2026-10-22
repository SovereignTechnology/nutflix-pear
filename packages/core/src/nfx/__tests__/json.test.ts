/**
 * The strict JSON reader against serde_json's grammar, beyond what the vectors reach: number
 * classes, depth, surrogates, duplicate keys and prototype keys.
 */
import { describe, expect, it } from 'vitest';

import { canonicalize } from '../canon.js';
import { JsonNumber, JsonObject, parseJson, type JsonValue } from '../json.js';

function parsed(text: string): JsonValue {
  const r = parseJson(text);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const intOf = (text: string): bigint | undefined => {
  const v = parsed(text);
  if (!(v instanceof JsonNumber)) throw new Error('not a number');
  return v.int;
};

describe('parseJson', () => {
  it('keeps integers exactly where serde_json reads integers', () => {
    expect(intOf('0')).toBe(0n);
    expect(intOf('18446744073709551615')).toBe(18446744073709551615n);
    expect(intOf('-9223372036854775808')).toBe(-9223372036854775808n);
    // serde_json reads these as floats: they parse, and no integer field accepts them.
    for (const text of ['-0', '1.0', '1e2', '18446744073709551616', '-9223372036854775809']) {
      expect(intOf(text), text).toBeUndefined();
    }
  });

  it('refuses what serde_json refuses', () => {
    const refused = [
      '',
      'NaN',
      '01',
      '+1',
      '.5',
      '1.',
      '1e400',
      `1${'0'.repeat(400)}`,
      '[1,]',
      '{"a":1,}',
      '{"a" 1}',
      "{'a':1}",
      '[1] x',
      '﻿{}',
      '"a\u0001"',
      '"\\x"',
      '"\\u12g4"',
      '"\\ud800"',
      '"\\udc00"',
      '"\\ud83d\\u0041"',
      '"\ud800"',
      'tru',
    ];
    for (const text of refused) expect(parseJson(text).ok, JSON.stringify(text)).toBe(false);
  });

  it('accepts escapes, surrogate pairs and surrounding whitespace', () => {
    expect(parsed(' \t\r\n"\\u00e9\\ud83d\\ude00\\/" \n')).toBe('é😀/');
    expect(parsed('"\u{1F600}"')).toBe('😀');
  });

  it('stops at serde_json depth: 127 nested containers parse, 128 do not', () => {
    expect(parseJson(`${'['.repeat(127)}${']'.repeat(127)}`).ok).toBe(true);
    expect(parseJson(`${'['.repeat(128)}${']'.repeat(128)}`).ok).toBe(false);
    expect(parseJson(`${'{"a":'.repeat(128)}1${'}'.repeat(128)}`).ok).toBe(false);
  });

  it('records duplicate keys and keeps the last value', () => {
    const v = parsed('{"a":1,"b":2,"a":3}');
    if (!(v instanceof JsonObject)) throw new Error('object');
    expect([...v.duplicates]).toEqual(['a']);
    expect((v.get('a') as JsonNumber).int).toBe(3n);
  });

  it('keeps `__proto__` as an ordinary key', () => {
    const v = parsed('{"__proto__":{"polluted":true},"constructor":1}');
    if (!(v instanceof JsonObject)) throw new Error('object');
    expect([...v.entries.keys()]).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    const canon = canonicalize('{"constructor":1,"__proto__":{"polluted":true}}');
    expect(canon).toEqual({ ok: true, value: '{"__proto__":{"polluted":true},"constructor":1}' });
  });
});
