// Room outline from a mesh's upward-facing triangles at the clicked height (pick a room from the model).
import { pointInPolygon, signedArea } from './placement.js';

const COS_UP = Math.cos((25 * Math.PI) / 180);
const MERGE = 200; // points within 5 mm share a key
type Pt = number[];
/** Flat triangle soup: 9 numbers (3 x [x, y, z], world metres) per triangle. */
export type Triangles = ArrayLike<number>;
/** Rasterised up-facing triangles (see rasterGrid). */
export interface OutlineGrid {
  grid: Uint8Array;
  W: number;
  H: number;
  x0: number;
  y0: number;
  c: number;
}

const key = (x: number, z: number): string => Math.round(x * MERGE) + ',' + Math.round(z * MERGE);

export function outlineLoops(tris: Triangles, y: number): Pt[][] {
  const pts = new Map<string, Pt>(); // key -> [x, z]
  const edgeCount = new Map<string, number>(); // undirected key -> count
  const edgeDir = new Map<string, [string, string]>(); // undirected key -> [p, q] as it appeared in a triangle
  for (let i = 0; i + 8 < tris.length; i += 9) {
    let a = [tris[i], tris[i + 1], tris[i + 2]], b = [tris[i + 3], tris[i + 4], tris[i + 5]], c = [tris[i + 6], tris[i + 7], tris[i + 8]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len || Math.abs(ny / len) < COS_UP) continue;
    if (Math.abs((a[1] + b[1] + c[1]) / 3 - y) > 0.05) continue;
    // Normalize winding: flip triangle if normal points down
    if (ny < 0) [b, c] = [c, b];
    const ks = [a, b, c].map((p) => { const k = key(p[0], p[2]); pts.set(k, [p[0], p[2]]); return k; });
    for (const [p, q] of [[ks[0], ks[1]], [ks[1], ks[2]], [ks[2], ks[0]]] as [string, string][]) {
      const e = p < q ? p + '|' + q : q + '|' + p;
      edgeCount.set(e, (edgeCount.get(e) || 0) + 1);
      // Store direction as it appears in the triangle
      edgeDir.set(e, [p, q]);
    }
  }
  const boundaryEdges: [string, string][] = [];
  const edgesByStart = new Map<string, number[]>(); // vertex key -> array of edge indices
  for (const [e, count] of edgeCount) {
    if (count !== 1) continue;
    const [p, q] = edgeDir.get(e)!; // set with the count
    const idx = boundaryEdges.length;
    boundaryEdges.push([p, q]);
    if (!edgesByStart.has(p)) edgesByStart.set(p, []);
    edgesByStart.get(p)!.push(idx);
  }
  const used = new Set<number>();
  const loops: Pt[][] = [];
  for (let startIdx = 0; startIdx < boundaryEdges.length; startIdx++) {
    if (used.has(startIdx)) continue;
    const loop: string[] = [];
    let edgeIdx = startIdx;
    for (;;) {
      if (used.has(edgeIdx)) break;
      used.add(edgeIdx);
      const [p, q] = boundaryEdges[edgeIdx];
      loop.push(p);
      const nexts = (edgesByStart.get(q) || []).filter((i) => !used.has(i));
      if (!nexts.length) break;
      let next: number;
      if (nexts.length === 1) {
        next = nexts[0];
      } else if (loop.length > 1) {
        // Pinch vertex: pick edge with smallest signed turning angle (most clockwise)
        // every edge end is a registered point
        const [px, pz] = pts.get(p)!, [qx, qz] = pts.get(q)!;
        const incoming = [qx - px, qz - pz];
        next = nexts.reduce((best, i) => {
          const [, qNext] = boundaryEdges[i];
          const [qnx, qnz] = pts.get(qNext)!;
          const outgoing = [qnx - qx, qnz - qz];
          const cross = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
          const dot = incoming[0] * outgoing[0] + incoming[1] * outgoing[1];
          const angle = Math.atan2(cross, dot);
          const [, qBest] = boundaryEdges[best];
          const [qbx, qbz] = pts.get(qBest)!;
          const bestVec = [qbx - qx, qbz - qz];
          const bestCross = incoming[0] * bestVec[1] - incoming[1] * bestVec[0];
          const bestDot = incoming[0] * bestVec[0] + incoming[1] * bestVec[1];
          const bestAngle = Math.atan2(bestCross, bestDot);
          return angle < bestAngle ? i : best;
        });
      } else {
        next = nexts[0];
      }
      if (next === startIdx && loop.length > 2) break;
      edgeIdx = next;
    }
    if (loop.length >= 3) loops.push(loop.map((k) => { const [x, z] = pts.get(k)!; return [x, -z]; }));
  }
  return loops.map(finishLoopLocal).filter((l): l is Pt[] => !!l);
}

// the smallest loop around the point (a merged mesh can span several rooms), else the largest loop whose box (+10 cm) holds it
export function pickLoop(loops: Pt[][], target: [number, number]): Pt[] | null {
  const area = (l: Pt[]) => Math.abs(signedArea(l));
  let candidates = loops.filter((l) => pointInPolygon(target, l)).sort((a, b) => area(a) - area(b));
  if (!candidates.length) {
    const near = (l: Pt[]) => l.some(([x]) => x <= target[0] + 0.1) && l.some(([x]) => x >= target[0] - 0.1)
      && l.some(([, y]) => y <= target[1] + 0.1) && l.some(([, y]) => y >= target[1] - 0.1);
    candidates = loops.filter(near).sort((a, b) => area(b) - area(a));
  }
  return candidates.length ? candidates[0] : null;
}

export function outlineFromTriangles(tris: Triangles, hit: Pt): Pt[] | null {
  return pickLoop(outlineLoops(tris, hit[1]), [hit[0], -hit[2]]);
}

// collinear removal (0.02 m) BEFORE snapping to 5 cm
function finishLoopLocal(simplified: Pt[]): Pt[] | null {
  const simp: Pt[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const p = simp.length ? simp[simp.length - 1] : simplified[simplified.length - 1];
    const c = simplified[i], n = simplified[(i + 1) % simplified.length];
    if (Math.hypot(c[0] - p[0], c[1] - p[1]) < 1e-6) continue;
    const dx = n[0] - p[0], dy = n[1] - p[1], l = Math.hypot(dx, dy) || 1;
    if (Math.abs((c[0] - p[0]) * dy - (c[1] - p[1]) * dx) / l < 0.02) continue; // collinear
    simp.push(c);
  }
  simplified = simp;
  const snapped = simplified.map(([x, y]) => [Math.round(x / 0.05) * 0.05, Math.round(y / 0.05) * 0.05].map((v) => Math.round(v * 1000) / 1000));
  const out: Pt[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const p = out.length ? out[out.length - 1] : snapped[snapped.length - 1];
    const c = snapped[i];
    if (Math.hypot(c[0] - p[0], c[1] - p[1]) < 1e-6) continue;
    out.push(c);
  }
  return out.length >= 3 ? out : null;
}


// Dense meshes: rasterise the up-facing triangles at the hit height onto a grid, flood-fill from the hit
// cell and walk the region's boundary. Same 25 degree / 0.05 m filters as outlineFromTriangles.
export function rasterGrid(tris: Triangles, yLevel: number, { cell = 0.02 }: { cell?: number } = {}): OutlineGrid | null {
  const keep: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const ux = tris[i + 3] - tris[i], uy = tris[i + 4] - tris[i + 1], uz = tris[i + 5] - tris[i + 2];
    const vx = tris[i + 6] - tris[i], vy = tris[i + 7] - tris[i + 1], vz = tris[i + 8] - tris[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!len || Math.abs(ny / len) < COS_UP) continue;
    if (Math.abs((tris[i + 1] + tris[i + 4] + tris[i + 7]) / 3 - yLevel) > 0.05) continue;
    keep.push(i);
    for (const o of [0, 3, 6]) {
      const x = tris[i + o], y = -tris[i + o + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!keep.length) return null;
  const MAX = 4000;
  let c = cell;
  c = Math.max(c, (x1 - x0) / MAX, (y1 - y0) / MAX);
  const W = Math.max(1, Math.ceil((x1 - x0) / c)), H = Math.max(1, Math.ceil((y1 - y0) / c));
  const grid = new Uint8Array(W * H);
  const clampI = (v: number, n: number) => Math.max(0, Math.min(n - 1, v));
  for (const i of keep) {
    const ax = tris[i], ay = -tris[i + 2], bx = tris[i + 3], by = -tris[i + 5], cx = tris[i + 6], cy = -tris[i + 8];
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    const ci = (x: number) => clampI(Math.floor((x - x0) / c), W), cj = (y: number) => clampI(Math.floor((y - y0) / c), H);
    for (const [px, py] of [[ax, ay], [bx, by], [cx, cy], [(ax + bx + cx) / 3, (ay + by + cy) / 3]]) grid[cj(py) * W + ci(px)] = 1;
    if (Math.abs(d) < 1e-12) continue;
    const ia = ci(Math.min(ax, bx, cx)), ib = ci(Math.max(ax, bx, cx)), ja = cj(Math.min(ay, by, cy)), jb = cj(Math.max(ay, by, cy));
    for (let j = ja; j <= jb; j++) {
      const py = y0 + (j + 0.5) * c;
      for (let ii = ia; ii <= ib; ii++) {
        const px = x0 + (ii + 0.5) * c;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
        if (l1 >= 0 && l2 >= 0 && 1 - l1 - l2 >= 0) grid[j * W + ii] = 1;
      }
    }
  }
  return { grid, W, H, x0, y0, c };
}

// flood fill from the hit cell (or a filled cell within 2 cells of it), then walk the region boundary
export function outlineFromGrid(g: OutlineGrid, hit: Pt): Pt[] | null {
  const { grid, W, H, x0, y0, c } = g;
  const hx = Math.floor((hit[0] - x0) / c), hy = Math.floor((-hit[2] - y0) / c);
  let start = -1;
  for (let r = 0; r <= 2 && start < 0; r++) {
    for (let dj = -r; dj <= r && start < 0; dj++) {
      for (let di = -r; di <= r; di++) {
        const i = hx + di, j = hy + dj;
        if (i >= 0 && j >= 0 && i < W && j < H && grid[j * W + i]) { start = j * W + i; break; }
      }
    }
  }
  if (start < 0) return null;
  const reg = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  stack[sp++] = start;
  reg[start] = 1;
  while (sp) {
    const p = stack[--sp], i = p % W, j = (p - i) / W;
    if (i > 0 && grid[p - 1] && !reg[p - 1]) { reg[p - 1] = 1; stack[sp++] = p - 1; }
    if (i < W - 1 && grid[p + 1] && !reg[p + 1]) { reg[p + 1] = 1; stack[sp++] = p + 1; }
    if (j > 0 && grid[p - W] && !reg[p - W]) { reg[p - W] = 1; stack[sp++] = p - W; }
    if (j < H - 1 && grid[p + W] && !reg[p + W]) { reg[p + W] = 1; stack[sp++] = p + W; }
  }
  // boundary edges with the region on their left (counter-clockwise outer loops)
  const V = W + 1;
  const out = new Map<number, number[]>(); // start vertex -> [end vertices]
  const add = (a: number, b: number) => { const l = out.get(a); if (l) l.push(b); else out.set(a, [b]); };
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (!reg[j * W + i]) continue;
      const v = j * V + i;
      if (j === 0 || !reg[(j - 1) * W + i]) add(v, v + 1);
      if (i === W - 1 || !reg[j * W + i + 1]) add(v + 1, v + 1 + V);
      if (j === H - 1 || !reg[(j + 1) * W + i]) add(v + 1 + V, v + V);
      if (i === 0 || !reg[j * W + i - 1]) add(v + V, v);
    }
  }
  let best: Pt[] | null = null, bestArea = 0;
  for (const [s0, starts] of out) {
    if (!starts.length) continue;
    const loop: number[] = [];
    let cur = s0;
    for (;;) {
      const l = out.get(cur);
      if (!l || !l.length) break;
      loop.push(cur);
      cur = l.pop()!; // non-empty
      if (cur === s0) break;
    }
    const pts = loop.map((v): Pt => [x0 + (v % V) * c, y0 + Math.floor(v / V) * c]);
    const a = pts.length >= 3 ? signedArea(pts) : 0;
    if (a > bestArea) { bestArea = a; best = pts; }
  }
  if (!best) return null;
  return finishLoop(best, 0.03);
}

export function outlineFromRaster(tris: Triangles, hit: Pt, opts?: { cell?: number }): Pt[] | null {
  const g = rasterGrid(tris, hit[1], opts);
  return g ? outlineFromGrid(g, hit) : null;
}

// merge exactly collinear points, Douglas-Peucker, snap to 5 cm, drop repeats
function finishLoop(poly: Pt[], tol: number): Pt[] | null {
  let p = poly.filter((c, i) => {
    const a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
    return Math.abs((c[0] - a[0]) * (b[1] - c[1]) - (c[1] - a[1]) * (b[0] - c[0])) > 1e-9;
  });
  if (p.length < 3) return null;
  let far = 0, fd = -1;
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > fd) { fd = d; far = i; } }
  const rdp = (pts: Pt[]): Pt[] => {
    const keepIdx: boolean[] = new Array(pts.length).fill(false);
    keepIdx[0] = keepIdx[pts.length - 1] = true;
    const st: [number, number][] = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop()!; // non-empty
      const dx = pts[b][0] - pts[a][0], dy = pts[b][1] - pts[a][1], l = Math.hypot(dx, dy) || 1;
      let m = -1, md = tol;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i][0] - pts[a][0]) * dy - (pts[i][1] - pts[a][1]) * dx) / l;
        if (d > md) { md = d; m = i; }
      }
      if (m >= 0) { keepIdx[m] = true; st.push([a, m], [m, b]); }
    }
    return pts.filter((_, i) => keepIdx[i]);
  };
  p = [...rdp(p.slice(0, far + 1)).slice(0, -1), ...rdp([...p.slice(far), p[0]]).slice(0, -1)];
  const snapped = p.map(([x, y]) => [Math.round(x / 0.05) * 0.05, Math.round(y / 0.05) * 0.05].map((v) => Math.round(v * 1000) / 1000));
  const res: Pt[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const q = res.length ? res[res.length - 1] : snapped[snapped.length - 1];
    if (Math.hypot(snapped[i][0] - q[0], snapped[i][1] - q[1]) < 1e-6) continue;
    res.push(snapped[i]);
  }
  return res.length >= 3 ? res : null;
}
