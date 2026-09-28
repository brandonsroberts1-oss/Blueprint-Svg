import type { Vec } from '../geometry/vec';
import { type Layer, type Stroke } from './types';

/** Heavier classes win when two lines overlap. Text and cut lines are never merged. */
const PRIORITY: Layer[] = ['outline', 'detail', 'annotation', 'hatch'];

interface Seg {
  a: Vec;
  b: Vec;
  layer: Layer;
  w?: number;
  theta: number;
}

/**
 * Remove overlapping collinear line segments (which would be burned twice) and
 * re-join the survivors into continuous polylines. Coordinates in mm.
 */
export function optimizeStrokes(strokes: readonly Stroke[], tol = 0.02): Stroke[] {
  const keep: Stroke[] = [];
  const segs: Seg[] = [];
  for (const s of strokes) {
    if (s.layer === 'text' || s.layer === 'cut') {
      keep.push(s);
      continue;
    }
    for (let i = 0; i + 1 < s.pts.length; i++) {
      const a = s.pts[i];
      const b = s.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      if (dx * dx + dy * dy < tol * tol * 0.01) continue;
      let theta = Math.atan2(dy, dx);
      if (theta < 0) theta += Math.PI;
      if (theta >= Math.PI - 1e-9) theta -= Math.PI;
      segs.push({ a, b, layer: s.layer, w: s.w, theta });
    }
  }

  const angTol = 0.0025;
  segs.sort((p, q) => p.theta - q.theta);
  // Treat angles just below PI as near 0 by folding.
  for (const s of segs) if (s.theta > Math.PI - angTol) s.theta -= Math.PI;
  segs.sort((p, q) => p.theta - q.theta);

  const out: Seg[] = [];
  let i = 0;
  while (i < segs.length) {
    let j = i + 1;
    while (j < segs.length && segs[j].theta - segs[j - 1].theta < angTol) j++;
    processAngleGroup(segs.slice(i, j), tol, out);
    i = j;
  }

  const byLayer = new Map<string, Seg[]>();
  for (const s of out) {
    const key = `${s.layer}|${s.w ?? ''}`;
    const list = byLayer.get(key) ?? [];
    list.push(s);
    byLayer.set(key, list);
  }
  const merged: Stroke[] = [];
  for (const list of byLayer.values()) {
    for (const pts of chain(list, tol)) merged.push({ layer: list[0].layer, pts, w: list[0].w });
  }
  return [...merged, ...keep];
}

function processAngleGroup(group: Seg[], tol: number, out: Seg[]) {
  const theta = group.reduce((s, g) => s + g.theta, 0) / group.length;
  const dir = { x: Math.cos(theta), y: Math.sin(theta) };
  const nrm = { x: -dir.y, y: dir.x };
  const items = group.map((g) => ({ g, d: g.a.x * nrm.x + g.a.y * nrm.y }));
  items.sort((p, q) => p.d - q.d);
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (j < items.length && items[j].d - items[j - 1].d < tol) j++;
    const line = items.slice(i, j).map((x) => x.g);
    if (line.length === 1) out.push(line[0]);
    else mergeCollinear(line, dir, tol, out);
    i = j;
  }
}

function mergeCollinear(line: Seg[], dir: Vec, tol: number, out: Seg[]) {
  const proj = (p: Vec) => p.x * dir.x + p.y * dir.y;
  const covered: [number, number][] = [];
  const ordered = [...line].sort((p, q) => PRIORITY.indexOf(p.layer) - PRIORITY.indexOf(q.layer));
  for (const s of ordered) {
    let s0 = proj(s.a);
    let s1 = proj(s.b);
    const flip = s0 > s1;
    if (flip) [s0, s1] = [s1, s0];
    // Subtract covered intervals.
    let pieces: [number, number][] = [[s0, s1]];
    for (const [c0, c1] of covered) {
      const next: [number, number][] = [];
      for (const [p0, p1] of pieces) {
        if (c1 <= p0 + tol || c0 >= p1 - tol) {
          next.push([p0, p1]);
          continue;
        }
        if (c0 > p0 + tol) next.push([p0, c0]);
        if (c1 < p1 - tol) next.push([c1, p1]);
      }
      pieces = next;
      if (!pieces.length) break;
    }
    const a = flip ? s.b : s.a;
    const b = flip ? s.a : s.b;
    const L = s1 - s0;
    for (const [p0, p1] of pieces) {
      if (p1 - p0 < tol) continue;
      const t0 = (p0 - s0) / L;
      const t1 = (p1 - s0) / L;
      out.push({
        a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
        b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
        layer: s.layer,
        w: s.w,
        theta: s.theta,
      });
    }
    covered.push([s0, s1]);
    covered.sort((p, q) => p[0] - q[0]);
    // merge covered
    const m: [number, number][] = [];
    for (const c of covered) {
      const last = m[m.length - 1];
      if (last && c[0] <= last[1] + tol) last[1] = Math.max(last[1], c[1]);
      else m.push([c[0], c[1]]);
    }
    covered.length = 0;
    covered.push(...m);
  }
}

/** Join segments that share endpoints into polylines. */
function chain(segs: Seg[], tol: number): Vec[][] {
  const q = (v: number) => Math.round(v / tol);
  const key = (p: Vec) => `${q(p.x)},${q(p.y)}`;
  const ends = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const l = ends.get(k);
      if (l) l.push(i);
      else ends.set(k, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const result: Vec[][] = [];
  const degree = (p: Vec) => (ends.get(key(p)) ?? []).filter((i) => !used[i]).length;

  const walk = (start: number, from: Vec) => {
    used[start] = 1;
    const s = segs[start];
    const forward = key(s.a) === key(from);
    const pts: Vec[] = forward ? [s.a, s.b] : [s.b, s.a];
    for (;;) {
      const tail = pts[pts.length - 1];
      const cands = (ends.get(key(tail)) ?? []).filter((i) => !used[i]);
      if (cands.length === 0) break;
      const n = cands[0];
      used[n] = 1;
      const ns = segs[n];
      pts.push(key(ns.a) === key(tail) ? ns.b : ns.a);
    }
    return pts;
  };

  // Start at open ends first so chains are maximal, then close cycles.
  segs.forEach((s, i) => {
    if (used[i]) return;
    if (degree(s.a) === 1) result.push(walk(i, s.a));
    else if (degree(s.b) === 1) result.push(walk(i, s.b));
  });
  segs.forEach((s, i) => {
    if (!used[i]) result.push(walk(i, s.a));
  });
  return result;
}
