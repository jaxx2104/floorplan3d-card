// RGBA pixel buffers for the map / mower image tests. Colours are [r, g, b], always opaque.

const packedCache = new Map();
const packed = (c) => {
  const k = c.join();
  let v = packedCache.get(k);
  if (v === undefined) {
    v = new Uint32Array(
      new Uint8ClampedArray([c[0], c[1], c[2], 255]).buffer,
    )[0];
    packedCache.set(k, v);
  }
  return v;
};
const views = new WeakMap();
const u32 = (a) => {
  let u = views.get(a);
  if (!u)
    views.set(a, (u = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2)));
  return u;
};

/** A w x h image of one colour. */
export function image(w, h, c) {
  const a = new Uint8ClampedArray(w * h * 4);
  new Uint32Array(a.buffer).fill(packed(c));
  return a;
}

/** Paint the rectangle (x0, y0, rw x rh) of a w-wide image. */
export function rect(a, w, x0, y0, rw, rh, c) {
  const u = u32(a),
    v = packed(c);
  for (let y = y0; y < y0 + rh; y++) u.fill(v, y * w + x0, y * w + x0 + rw);
}

/** Paint one pixel. */
export function setPixel(a, w, x, y, c) {
  u32(a)[y * w + x] = packed(c);
}
