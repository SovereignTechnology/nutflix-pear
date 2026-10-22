/**
 * A strict JSON reader with serde_json's grammar, for NFX bytes that come off the wire (beacon
 * content, hash lists, `canon` input). `JSON.parse` cannot serve: it rounds every number to a
 * double and keeps the last of two equal keys without a word. This reader keeps each number as
 * written and reports duplicate keys, so each caller applies nfx-proto's rule for them:
 * `canon` rejects a duplicate, a hash list rejects a repeated field, beacon content keeps the
 * last (serde_json's `Value`). Objects are `Map`s, so no key (`__proto__` included) ever
 * reaches a prototype.
 */
import type { Result } from '../contracts/index.js';
import { U64_MAX } from './util.js';

/** serde_json's recursion limit: the 128th nested container is refused. */
const MAX_DEPTH = 128;
const I64_MIN = -0x8000_0000_0000_0000n;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

export class JsonNumber {
  /**
   * The value, when the text is an integer serde_json reads as one: no fraction or exponent,
   * not `-0`, within −2^63 … 2^64 − 1. Anything else serde_json reads as a float.
   */
  readonly int: bigint | undefined;

  constructor(readonly text: string) {
    let int: bigint | undefined;
    // 21 characters hold every u64 and i64; a longer integer is a float to serde_json, and
    // is never handed to BigInt, whose parse is superlinear in the digits a peer may send.
    if (text.length <= 21 && !/[.eE]/.test(text) && text !== '-0') {
      const value = BigInt(text);
      if (value >= I64_MIN && value <= U64_MAX) int = value;
    }
    this.int = int;
  }
}

export class JsonObject {
  constructor(
    readonly entries: ReadonlyMap<string, JsonValue>,
    /** Keys that appeared more than once; `entries` holds the last value of each. */
    readonly duplicates: ReadonlySet<string>,
  ) {}

  get(key: string): JsonValue | undefined {
    return this.entries.get(key);
  }
}

export type JsonValue = null | boolean | string | JsonNumber | readonly JsonValue[] | JsonObject;

export function isJsonArray(v: JsonValue | undefined): v is readonly JsonValue[] {
  return Array.isArray(v);
}

/** The value as serde_json's `Value::as_u64` reads it. */
export function asU64(v: JsonValue | undefined): bigint | undefined {
  return v instanceof JsonNumber && v.int !== undefined && v.int >= 0n ? v.int : undefined;
}

class JsonSyntaxError extends Error {}

/** Parse JSON text, or say why it is not JSON. Trailing whitespace is allowed, nothing else. */
export function parseJson(text: string): Result<JsonValue, string> {
  const reader = new Reader(text);
  try {
    const value = reader.value(0);
    reader.whitespace();
    if (reader.pos !== text.length) reader.fail('trailing characters');
    return { ok: true, value };
  } catch (e: unknown) {
    if (e instanceof JsonSyntaxError) return { ok: false, error: e.message };
    throw e;
  }
}

class Reader {
  pos = 0;

  constructor(private readonly s: string) {}

  fail(reason: string): never {
    throw new JsonSyntaxError(`${reason} at offset ${this.pos}`);
  }

  whitespace(): void {
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.pos++;
    }
  }

  value(depth: number): JsonValue {
    this.whitespace();
    const c = this.s[this.pos];
    if (c === '{') return this.object(depth + 1);
    if (c === '[') return this.array(depth + 1);
    if (c === '"') return this.string();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    return this.fail(c === undefined ? 'EOF while parsing a value' : 'expected value');
  }

  private object(depth: number): JsonObject {
    if (depth >= MAX_DEPTH) this.fail('recursion limit exceeded');
    this.pos++;
    const entries = new Map<string, JsonValue>();
    const duplicates = new Set<string>();
    this.whitespace();
    if (this.s[this.pos] === '}') {
      this.pos++;
      return new JsonObject(entries, duplicates);
    }
    for (;;) {
      this.whitespace();
      if (this.s[this.pos] !== '"') this.fail('key must be a string');
      const key = this.string();
      this.whitespace();
      if (this.s[this.pos] !== ':') this.fail("expected ':'");
      this.pos++;
      const value = this.value(depth);
      if (entries.has(key)) duplicates.add(key);
      entries.set(key, value);
      this.whitespace();
      const c = this.s[this.pos];
      this.pos++;
      if (c === '}') return new JsonObject(entries, duplicates);
      if (c !== ',') this.fail("expected ',' or '}'");
    }
  }

  private array(depth: number): JsonValue[] {
    if (depth >= MAX_DEPTH) this.fail('recursion limit exceeded');
    this.pos++;
    const items: JsonValue[] = [];
    this.whitespace();
    if (this.s[this.pos] === ']') {
      this.pos++;
      return items;
    }
    for (;;) {
      // After a comma a value must follow: `[1,]` fails here with "expected value".
      items.push(this.value(depth));
      this.whitespace();
      const c = this.s[this.pos];
      this.pos++;
      if (c === ']') return items;
      if (c !== ',') this.fail("expected ',' or ']'");
    }
  }

  private string(): string {
    this.pos++;
    let out = '';
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.s.length) this.fail('EOF while parsing a string');
      const c = this.s.charCodeAt(this.pos);
      if (c === 0x22) {
        out += this.s.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c === 0x5c) {
        out += this.s.slice(start, this.pos);
        this.pos++;
        out += this.escape();
        start = this.pos;
      } else if (c < 0x20) {
        this.fail('control character in string');
      } else if (c >= 0xd800 && c <= 0xdbff) {
        // Text decoded from strict UTF-8 never has a lone surrogate, a JavaScript string may.
        const d = this.s.charCodeAt(this.pos + 1);
        if (!(d >= 0xdc00 && d <= 0xdfff)) this.fail('lone surrogate in string');
        this.pos += 2;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        this.fail('lone surrogate in string');
      } else {
        this.pos++;
      }
    }
  }

  private escape(): string {
    const c = this.s[this.pos];
    this.pos++;
    switch (c) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const high = this.hex4();
        if (high >= 0xdc00 && high <= 0xdfff) this.fail('lone trailing surrogate in hex escape');
        if (high < 0xd800 || high > 0xdbff) return String.fromCharCode(high);
        if (this.s[this.pos] !== '\\' || this.s[this.pos + 1] !== 'u') {
          this.fail('lone leading surrogate in hex escape');
        }
        this.pos += 2;
        const low = this.hex4();
        if (low < 0xdc00 || low > 0xdfff) this.fail('lone leading surrogate in hex escape');
        return String.fromCharCode(high, low);
      }
      default:
        return this.fail('invalid escape');
    }
  }

  private hex4(): number {
    const digits = this.s.slice(this.pos, this.pos + 4);
    if (!HEX4.test(digits)) this.fail('invalid \\u escape');
    this.pos += 4;
    return parseInt(digits, 16);
  }

  private number(): JsonNumber {
    NUMBER.lastIndex = this.pos;
    const m = NUMBER.exec(this.s);
    if (m === null) return this.fail('invalid number');
    const n = new JsonNumber(m[0]);
    // serde_json reads a non-integer as an f64, and refuses one that overflows it.
    if (n.int === undefined && !Number.isFinite(Number(m[0]))) this.fail('number out of range');
    this.pos += m[0].length;
    return n;
  }

  private literal<T extends boolean | null>(word: string, value: T): T {
    if (!this.s.startsWith(word, this.pos)) this.fail('expected value');
    this.pos += word.length;
    return value;
  }
}
