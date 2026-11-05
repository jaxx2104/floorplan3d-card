// Tiny schema combinators for the stored layout and the card config. A schema parses unknown JSON into
// a typed value and never throws: what does not fit is dropped (or replaced by its default) and
// reported as a warning with its path. Object schemas keep fields they do not know, so data written by
// a newer or older card survives a load / save round trip. The TypeScript types are derived from the
// schemas (Infer), so the validators and the types cannot drift apart.

/** A value that did not fit the schema. path: "rooms[2].polygon[0]", "mower.overlay.width". */
export interface Issue { path: string; message: string }

/** Collected while parsing: problems (dropped or defaulted values) and paths of fields kept unchecked. */
export interface Ctx {
  warnings: Issue[];
  unknown: string[];
}

export const INVALID: unique symbol = Symbol('invalid');
export type Parsed<T> = T | typeof INVALID;

export interface Schema<T> {
  /** Short description for messages ("number", "'a' | 'b'"). */
  readonly expected: string;
  parse(input: unknown, path: string, ctx: Ctx): Parsed<T>;
}
/** An object field that may be absent (also: dropped when invalid). */
export interface OptionalSchema<T> extends Schema<T> { readonly optional: true }
/** An object field with a default (absent or invalid: the default). */
export interface DefaultSchema<T> extends Schema<T> { readonly fallback: () => T }

export type Infer<S> = S extends Schema<infer T> ? T : never;

export const newCtx = (): Ctx => ({ warnings: [], unknown: [] });

const describe = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v);
  if (typeof v === 'object') return 'an object';
  return String(v);
};
const fail = (ctx: Ctx, path: string, expected: string, got: unknown): typeof INVALID => {
  ctx.warnings.push({ path: path || '(root)', message: `expected ${expected}, got ${describe(got)}` });
  return INVALID;
};
const join = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

// JSON.parse makes "__proto__" an own key; copying it would set the copy's prototype instead
const dropProto = (ctx: Ctx, path: string): void => { ctx.warnings.push({ path, message: 'not allowed as a key; dropped' }); };

export const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function check<T>(expected: string, ok: (v: unknown) => v is T): Schema<T> {
  return { expected, parse: (v, path, ctx) => (ok(v) ? v : fail(ctx, path, expected, v)) };
}

export const string = (): Schema<string> => check('a string', (v): v is string => typeof v === 'string');
/** A finite number. */
export const number = (): Schema<number> => check('a number', (v): v is number => typeof v === 'number' && Number.isFinite(v));
export const boolean = (): Schema<boolean> => check('true / false', (v): v is boolean => typeof v === 'boolean');
/** Anything but undefined, kept as is (validated by the module that owns it). */
export const unknownValue = (): Schema<unknown> => ({ expected: 'a value', parse: (v) => v });
/** A plain object, kept as is (its fields are validated by the module that owns it). */
export const anyObject = (): Schema<Record<string, unknown>> => check('an object', isPlainObject);

/** A finite number, or a string holding one (YAML / form input). */
export const numeric = (): Schema<number> => ({
  expected: 'a number',
  parse(v, path, ctx) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? n : fail(ctx, path, 'a number', v);
  },
});

export function literal<const L extends readonly (string | number | boolean)[]>(...values: L): Schema<L[number]> {
  const expected = values.map((v) => JSON.stringify(v).replaceAll('"', "'")).join(' | ');
  return check(expected, (v): v is L[number] => values.includes(v as L[number]));
}

export function nullable<T>(s: Schema<T>): Schema<T | null> {
  return { expected: `${s.expected} or null`, parse: (v, path, ctx) => (v === null ? null : s.parse(v, path, ctx)) };
}

/** The first schema that fits (warnings of the failed attempts are not reported). */
export function union<S extends readonly Schema<unknown>[]>(...schemas: S): Schema<Infer<S[number]>> {
  const expected = schemas.map((s) => s.expected).join(' or ');
  return {
    expected,
    parse(v, path, ctx) {
      for (const s of schemas) {
        const probe = newCtx();
        const out = s.parse(v, path, probe);
        if (out !== INVALID) { ctx.warnings.push(...probe.warnings); ctx.unknown.push(...probe.unknown); return out as Infer<S[number]>; }
      }
      return fail(ctx, path, expected, v);
    },
  };
}

/** A list; items that do not fit are dropped (warned). */
export function array<T>(item: Schema<T>): Schema<T[]> {
  return {
    expected: 'a list',
    parse(v, path, ctx) {
      if (!Array.isArray(v)) return fail(ctx, path, 'a list', v);
      const out: T[] = [];
      v.forEach((x, i) => { const p = item.parse(x, join(path, i), ctx); if (p !== INVALID) out.push(p); });
      return out;
    },
  };
}

/** A fixed-length list of numbers, e.g. [x, y, z]; extra items are kept out. */
export function tuple<const N extends number>(n: N, expected = `[${n} numbers]`): Schema<NumberTuple<N>> {
  const num = number();
  return {
    expected,
    parse(v, path, ctx) {
      if (!Array.isArray(v) || v.length < n) return fail(ctx, path, expected, v);
      const head = v.slice(0, n);
      return head.every((x) => num.parse(x, path, newCtx()) !== INVALID) ? (head as NumberTuple<N>) : fail(ctx, path, expected, v);
    },
  };
}
type Build<N extends number, Acc extends number[]> = Acc['length'] extends N ? Acc : Build<N, [...Acc, number]>;
export type NumberTuple<N extends number> = Build<N, []>;

/** An object used as a map (id -> value); entries that do not fit are dropped (warned). */
export function record<T>(value: Schema<T>): Schema<Record<string, T>> {
  return {
    expected: 'an object',
    parse(v, path, ctx) {
      if (!isPlainObject(v)) return fail(ctx, path, 'an object', v);
      const out: Record<string, T> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === '__proto__') { dropProto(ctx, join(path, k)); continue; }
        const p = value.parse(x, join(path, k), ctx);
        if (p !== INVALID) out[k] = p;
      }
      return out;
    },
  };
}

/** Field modifier: may be absent; an invalid value is dropped (warned). */
export function optional<T>(s: Schema<T>): OptionalSchema<T> {
  return { ...s, optional: true };
}

/** Field modifier: absent -> the default; an invalid value is replaced by it (warned). */
export function withDefault<T>(s: Schema<T>, fallback: () => NoInfer<T>): DefaultSchema<T> {
  return { ...s, fallback };
}

/** Post-process a parsed value (pure; must not throw). */
export function map<A, B>(s: Schema<A>, fn: (a: A) => B, expected = s.expected): Schema<B> {
  return { expected, parse: (v, path, ctx) => { const a = s.parse(v, path, ctx); return a === INVALID ? INVALID : fn(a); } };
}

/** Narrow a parsed value with a predicate. */
export function refine<T>(s: Schema<T>, ok: (v: T) => boolean, expected: string): Schema<T> {
  return {
    expected,
    parse(v, path, ctx) {
      const probe = newCtx();
      const out = s.parse(v, path, probe);
      if (out === INVALID || !ok(out)) return fail(ctx, path, expected, v);
      ctx.warnings.push(...probe.warnings); ctx.unknown.push(...probe.unknown);
      return out;
    },
  };
}

export type Shape = Record<string, Schema<unknown>>;
type OptKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never }[keyof S];
type Known<S extends Shape> =
  & { -readonly [K in keyof S as K extends OptKeys<S> ? never : K]: Infer<S[K]> }
  & { -readonly [K in keyof S as K extends OptKeys<S> ? K : never]?: Infer<S[K]> };
type Flat<T> = { [K in keyof T]: T[K] } & {};
/** Fields the schema does not know: kept, unchecked. */
export type Rest = { [key: string]: unknown };
export type ObjectOf<S extends Shape> = Flat<Known<S>> & Rest;

/**
 * An object with known fields. Plain fields are required (missing / invalid: the whole object does
 * not fit), optional() ones may be absent, withDefault() ones always end up present. Unknown fields
 * are kept as they are (their paths land in ctx.unknown).
 */
export function object<S extends Shape>(shape: S, expected = 'an object'): Schema<ObjectOf<S>> & { readonly shape: S } {
  return {
    expected,
    shape,
    parse(v, path, ctx) {
      if (!isPlainObject(v)) return fail(ctx, path, expected, v);
      const out: Record<string, unknown> = {};
      // the input's key order is kept (stored JSON stays diff friendly); defaults go last
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined) continue;
        const p = join(path, k);
        if (k === '__proto__') { dropProto(ctx, p); continue; }
        if (!Object.hasOwn(shape, k)) { out[k] = x; ctx.unknown.push(p); continue; }
        const s = shape[k];
        const r = s.parse(x, p, ctx);
        if (r === undefined) continue; // read as absent
        if (r !== INVALID) out[k] = r;
        else if ((s as Partial<DefaultSchema<unknown>>).fallback) out[k] = (s as DefaultSchema<unknown>).fallback();
        else if (!(s as Partial<OptionalSchema<unknown>>).optional) return INVALID;
      }
      for (const [k, s] of Object.entries(shape)) {
        if (k in out) continue;
        const fallback = (s as Partial<DefaultSchema<unknown>>).fallback;
        if (fallback) out[k] = fallback();
        else if (!(s as Partial<OptionalSchema<unknown>>).optional) {
          if (v[k] === undefined) ctx.warnings.push({ path: join(path, k), message: 'missing' });
          return INVALID;
        }
      }
      return out as ObjectOf<S>;
    },
  };
}

/** Run a schema on input: { value, warnings, unknown }; value null when the root does not fit. */
export function run<T>(s: Schema<T>, input: unknown): { value: T | null; warnings: Issue[]; unknown: string[] } {
  const ctx = newCtx();
  const out = s.parse(input, '', ctx);
  return { value: out === INVALID ? null : out, warnings: ctx.warnings, unknown: ctx.unknown };
}

/** Plain JSON: no undefined fields (JSON.stringify drops them anyway), a fresh copy. */
export function toJson<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Deep structural equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}
