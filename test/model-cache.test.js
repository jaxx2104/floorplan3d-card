import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import {
  layoutModelVersion,
  headerVersion,
  cacheUrl,
  cacheBase,
  lruEvict,
  progressText,
  readWithProgress,
  withTimeout,
  loadModelBuffer,
  evictModel,
} from "../src/model-cache.ts";

describe("model cache versions", () => {
  it("versions an uploaded model by its version, size and upload time", () => {
    expect(
      layoutModelVersion({
        version: "abc",
        size: 100,
        uploaded: "2026-01-01T00:00:00Z",
      }),
    ).toBe("abc:100:2026-01-01T00:00:00Z");
    expect(layoutModelVersion({ version: "abc" })).toBe("abc::");
    expect(layoutModelVersion({ size: 100 })).toBe(null);
    expect(layoutModelVersion(null)).toBe(null);
  });
  it("versions a URL model by ETag, else Last-Modified (with the length)", () => {
    const h = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
    expect(headerVersion(h({ etag: '"x1"', "content-length": "10" }))).toBe(
      'etag:"x1"',
    );
    expect(
      headerVersion(
        h({
          "last-modified": "Tue, 06 Oct 2026 10:00:00 GMT",
          "content-length": "10",
        }),
      ),
    ).toBe("lm:Tue, 06 Oct 2026 10:00:00 GMT:10");
    expect(headerVersion(h({ "content-length": "10" }))).toBe(null);
    expect(headerVersion(null)).toBe(null);
  });
  it("keys a cached response by URL + version, never by query tokens of the base", () => {
    expect(cacheUrl("http://h/api/floorplan3d/model/default", "v1:2:")).toBe(
      "http://h/api/floorplan3d/model/default?fp_v=v1%3A2%3A",
    );
    expect(cacheUrl("http://h/local/house.glb?x=1", "e")).toBe(
      "http://h/local/house.glb?x=1&fp_v=e",
    );
    expect(cacheBase("http://h/local/house.glb?x=1&fp_v=e")).toBe(
      "http://h/local/house.glb?x=1",
    );
    expect(cacheBase("http://h/api/floorplan3d/model/default?fp_v=v1")).toBe(
      "http://h/api/floorplan3d/model/default",
    );
  });
});

describe("lruEvict", () => {
  const e = (key, size, at) => ({ key, size, at });
  it("evicts the least recently used entries until the total fits", () => {
    expect(lruEvict([e("a", 1, 3), e("b", 1, 1), e("c", 1, 2)], 2)).toEqual([
      "b",
    ]);
    expect(lruEvict([e("a", 1, 3), e("b", 1, 1), e("c", 1, 2)], 1)).toEqual([
      "b",
      "c",
    ]);
    expect(lruEvict([e("a", 1, 3)], 5)).toEqual([]);
  });
  it("never evicts the kept key unless it alone is over the cap", () => {
    expect(lruEvict([e("a", 2, 1), e("b", 2, 9)], 3, "a")).toEqual(["b"]);
    expect(lruEvict([e("a", 5, 1), e("b", 1, 9)], 3, "a")).toEqual(["a"]);
  });
});

describe("progressText", () => {
  it("shows MB downloaded of the total", () => {
    expect(progressText(3.2e6, 6.1e6)).toBe("Downloading 3.2 / 6.1 MB");
    expect(progressText(1048576 * 0.5, 0)).toBe("Downloading 0.5 MB");
  });
  it("received bytes only when content-length is smaller (a gzip-encoded body)", () => {
    expect(progressText(5e6, 2e6)).toBe("Downloading 5.0 MB");
    expect(progressText(2e6, 2e6)).toBe("Downloading 2.0 / 2.0 MB");
  });
});

describe("readWithProgress", () => {
  it("streams the body and reports progress", async () => {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const body = new ReadableStream({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    });
    const res = new Response(body, { headers: { "content-length": "3" } });
    const seen = [];
    const buf = await readWithProgress(res, (l, t) => seen.push([l, t]));
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
    expect(seen).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });
  it("falls back to arrayBuffer without a stream", async () => {
    const res = {
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new Uint8Array([9]).buffer,
    };
    const buf = await readWithProgress(res, () => {});
    expect([...new Uint8Array(buf)]).toEqual([9]);
  });
});

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());
  it("passes the value through in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 50, "slow")).resolves.toBe(7);
  });
  it("rejects with the message after ms and calls onTimeout", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const p = withTimeout(
      new Promise(() => {}),
      10,
      "Model download timed out",
      () => {
        aborted = true;
      },
    );
    vi.advanceTimersByTime(9);
    expect(aborted).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(p).rejects.toThrow("Model download timed out");
    expect(aborted).toBe(true);
  });
});

// Cache Storage stand-in: one cache, requests keyed by URL.
function fakeCaches() {
  const store = new Map();
  const cache = {
    match: async (url) => {
      const b = store.get(url);
      return b ? new Response(b) : undefined;
    },
    put: async (url, res) => {
      store.set(url, new Uint8Array(await res.arrayBuffer()));
    },
    keys: async () => [...store.keys()].map((url) => ({ url })),
    delete: async (req) => store.delete(req.url),
  };
  return { store, caches: { open: async () => cache } };
}

describe("loadModelBuffer", () => {
  const base = "http://x/m.glb";
  let saved, fake;
  beforeEach(() => {
    saved = globalThis.caches;
    fake = fakeCaches();
    globalThis.caches = fake.caches;
  });
  afterEach(() => {
    globalThis.caches = saved;
    vi.useRealTimers();
  });
  const bytes = (r) => [...new Uint8Array(r.buf)];
  const serving = (b) => {
    const fn = vi.fn(async () => new Response(new Uint8Array(b)));
    return fn;
  };

  it("fetches once per version, then serves the cached copy", async () => {
    const fetchFn = serving([1, 2]);
    const first = await loadModelBuffer({ base, version: "v1", fetchFn });
    expect(first.cached).toBe(false);
    const again = await loadModelBuffer({ base, version: "v1", fetchFn });
    expect(again.cached).toBe(true);
    expect(bytes(again)).toEqual([1, 2]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("a new version replaces the old one in the cache", async () => {
    await loadModelBuffer({ base, version: "v1", fetchFn: serving([1]) });
    const r = await loadModelBuffer({
      base,
      version: "v2",
      fetchFn: serving([2]),
    });
    expect(r.cached).toBe(false);
    expect([...fake.store.keys()]).toEqual([cacheUrl(base, "v2")]);
  });
  it("skipCache fetches even with a cached copy, and replaces it", async () => {
    await loadModelBuffer({ base, version: "v1", fetchFn: serving([1]) });
    const r = await loadModelBuffer({
      base,
      version: "v1",
      fetchFn: serving([7]),
      skipCache: true,
    });
    expect(r.cached).toBe(false);
    expect(bytes(r)).toEqual([7]);
    const next = await loadModelBuffer({
      base,
      version: "v1",
      fetchFn: serving([0]),
    });
    expect(bytes(next)).toEqual([7]);
  });
  it("version null is never cached", async () => {
    const fetchFn = serving([1]);
    await loadModelBuffer({ base, version: null, fetchFn });
    await loadModelBuffer({ base, version: null, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fake.store.size).toBe(0);
  });
  it("evictModel drops every cached version of the model", async () => {
    await loadModelBuffer({ base, version: "v1", fetchFn: serving([1]) });
    await loadModelBuffer({
      base: "http://x/other.glb",
      version: "v1",
      fetchFn: serving([1]),
    });
    await evictModel(base);
    expect([...fake.store.keys()]).toEqual([
      cacheUrl("http://x/other.glb", "v1"),
    ]);
  });
  it("an HTTP error rejects with its status and is not cached", async () => {
    const fetchFn = async () => new Response("no", { status: 404 });
    await expect(
      loadModelBuffer({ base, version: "v1", fetchFn }),
    ).rejects.toThrow("HTTP 404");
    expect(fake.store.size).toBe(0);
  });
  it("a stalled download fails after the timeout and aborts the request", async () => {
    vi.useFakeTimers();
    let signal = null;
    const fetchFn = (o) => {
      signal = o.signal;
      return new Promise(() => {});
    };
    const p = loadModelBuffer({ base, version: null, fetchFn, timeoutMs: 10 });
    await Promise.resolve();
    vi.advanceTimersByTime(10);
    await expect(p).rejects.toThrow(/timed out/);
    expect(signal.aborted).toBe(true);
  });
});
