// Local cache of model files (.glb): Cache Storage when the page has it (secure contexts), else an
// IndexedDB blob (HA over plain http on the LAN), keyed by the model URL + its version. Only the
// response body is stored, under a plain URL: never request headers or tokens.
import { idbGet, idbAll, idbPut, idbDelete } from './idb.js';
import type { LayoutModel } from './types/layout.js';

/** IndexedDB record of a cached model body. */
interface ModelRecord {
  key: string;
  version: string;
  blob: Blob;
  size: number;
  at: number;
}
export interface LruEntry {
  key: string;
  size?: number;
  at: number;
}

export const CACHE_NAME = 'floorplan3d-models';
export const IDB_MODEL_CAP = 50 * 1024 * 1024;

// Uploaded model (layout.model): version + size + upload time, no request needed. -> string | null
export function layoutModelVersion(m: Pick<LayoutModel, 'version' | 'size' | 'uploaded'> | null | undefined): string | null {
  if (!m || !m.version) return null;
  return `${m.version}:${m.size ?? ''}:${m.uploaded ?? ''}`;
}

// URL model: from the HEAD response headers (ETag, else Last-Modified + length). -> string | null
export function headerVersion(headers: Pick<Headers, 'get'> | null | undefined): string | null {
  if (!headers || typeof headers.get !== 'function') return null;
  const etag = headers.get('etag');
  if (etag) return `etag:${etag}`;
  const lm = headers.get('last-modified');
  if (lm) return `lm:${lm}:${headers.get('content-length') ?? ''}`;
  return null;
}

export function cacheUrl(base: string, version: string): string {
  return `${base}${base.includes('?') ? '&' : '?'}fp_v=${encodeURIComponent(version)}`;
}

export function cacheBase(url: string): string {
  return url.replace(/[?&]fp_v=[^&]*$/, '');
}

// Least recently used first until the total fits cap; keep is evicted only when it alone is too big.
// entries [{ key, size, at }] -> keys to delete
export function lruEvict(entries: LruEntry[], cap: number, keep: string | null = null): string[] {
  const out: string[] = [];
  let total = entries.reduce((s, e) => s + (e.size || 0), 0);
  const kept = entries.find((e) => e.key === keep);
  if (kept && (kept.size ?? 0) > cap) { out.push(kept.key); total -= kept.size ?? 0; } // > cap: a number
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (total <= cap) break;
    if (e.key === keep) continue;
    out.push(e.key);
    total -= e.size || 0;
  }
  return out;
}

const mb = (n: number): string => (n / 1e6).toFixed(1);
// total: content-length (0 unknown); smaller than what arrived (a gzip-encoded body): received bytes only
export function progressText(loaded: number, total?: number | null): string {
  return total && loaded <= total ? `Downloading ${mb(loaded)} / ${mb(total)} MB` : `Downloading ${mb(loaded)} MB`;
}

export const MODEL_TIMEOUT_MS = 60000;

// promise, rejected with Error(message) after ms (onTimeout() first, e.g. to abort the request).
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout: (() => void) | null = null): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { if (onTimeout) onTimeout(); reject(new Error(message)); }, ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Response body as an ArrayBuffer, with onProgress(loaded, total) per chunk (total 0: unknown).
export async function readWithProgress(res: Response, onProgress?: ((loaded: number, total: number) => void) | null): Promise<ArrayBuffer> {
  const total = Number(res.headers && res.headers.get('content-length')) || 0;
  if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    if (onProgress) onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined' || !caches) return null;
    return await caches.open(CACHE_NAME);
  } catch (e) {
    return null; // insecure context, storage blocked
  }
}

// -> ArrayBuffer | null
async function cachedBody(base: string, version: string): Promise<ArrayBuffer | null> {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(cacheUrl(base, version));
      return hit ? await hit.arrayBuffer() : null;
    } catch (e) {
      return null;
    }
  }
  const rec = await idbGet<ModelRecord>('models', base);
  if (!rec || rec.version !== version || !rec.blob) return null;
  idbPut('models', { ...rec, at: Date.now() }); // LRU touch
  try {
    return await rec.blob.arrayBuffer();
  } catch (e) {
    return null;
  }
}

async function storeBody(base: string, version: string, buf: ArrayBuffer): Promise<void> {
  const cache = await openCache();
  if (cache) {
    try {
      // older versions of the same model go
      for (const req of await cache.keys()) if (cacheBase(req.url) === base) await cache.delete(req);
      await cache.put(cacheUrl(base, version), new Response(buf, { headers: { 'content-type': 'model/gltf-binary', 'content-length': String(buf.byteLength) } }));
    } catch (e) { /* quota: not cached */ }
    return;
  }
  if (buf.byteLength > IDB_MODEL_CAP) return;
  const ok = await idbPut('models', { key: base, version, blob: new Blob([buf]), size: buf.byteLength, at: Date.now() });
  if (!ok) return;
  const all = await idbAll<ModelRecord>('models');
  const drop = lruEvict(all.map((r) => ({ key: r.key, size: r.size, at: r.at })), IDB_MODEL_CAP, base);
  if (drop.length) await idbDelete('models', drop);
}

// The model's bytes: from the local cache when the version matches, else fetched (with progress) and
// stored. base: absolute URL without the version; version: string | null (null: never cached);
// fetchFn: () => Promise<Response>. -> { buf, cached }
// fetchFn({ signal }): the request is aborted when the download (headers + body) takes longer than
// timeoutMs (default 60 s). skipCache: fetch even when a cached copy exists (it is replaced).
export async function loadModelBuffer({ base, version, fetchFn, onProgress, timeoutMs = MODEL_TIMEOUT_MS, skipCache = false }: {
  base: string;
  version: string | null;
  fetchFn: (init: { signal?: AbortSignal }) => Promise<Response>;
  onProgress?: ((loaded: number, total: number) => void) | null;
  timeoutMs?: number;
  skipCache?: boolean;
}): Promise<{ buf: ArrayBuffer; cached: boolean }> {
  if (version && !skipCache) {
    const hit = await cachedBody(base, version);
    if (hit) return { buf: hit, cached: true };
  }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const download = (async () => {
    const res = await fetchFn({ signal: ctl ? ctl.signal : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return readWithProgress(res, onProgress);
  })();
  const buf = await withTimeout(download, timeoutMs, `Model download timed out (${+(timeoutMs / 1000).toFixed(1)} s)`, () => ctl && ctl.abort());
  if (version) await storeBody(base, version, buf);
  return { buf, cached: false };
}

// Drop a cached model (all versions of base), e.g. when its bytes fail to parse.
export async function evictModel(base: string): Promise<void> {
  const cache = await openCache();
  if (cache) {
    try { for (const req of await cache.keys()) if (cacheBase(req.url) === base) await cache.delete(req); } catch (e) { /* blocked */ }
    return;
  }
  await idbDelete('models', [base]);
}
