import type { Vec } from '../geometry/vec';

/** Binary mask on a pixel grid (1 = set). */
export interface Mask {
  w: number;
  h: number;
  data: Uint8Array;
}

export const emptyMask = (w: number, h: number): Mask => ({ w, h, data: new Uint8Array(w * h) });

export function maskWhere(w: number, h: number, test: (i: number) => boolean): Mask {
  const m = emptyMask(w, h);
  for (let i = 0; i < w * h; i++) if (test(i)) m.data[i] = 1;
  return m;
}

export function countMask(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

export function andMask(a: Mask, b: Mask): Mask {
  return maskWhere(a.w, a.h, (i) => a.data[i] === 1 && b.data[i] === 1);
}

export function orMask(a: Mask, b: Mask): Mask {
  return maskWhere(a.w, a.h, (i) => a.data[i] === 1 || b.data[i] === 1);
}

export function subMask(a: Mask, b: Mask): Mask {
  return maskWhere(a.w, a.h, (i) => a.data[i] === 1 && b.data[i] === 0);
}

/** Separable square dilation (r > 0) or erosion (r < 0) with a (2|r|+1)² window. */
export function morph(m: Mask, r: number): Mask {
  if (r === 0) return { ...m, data: m.data.slice() };
  const { w, h } = m;
  const k = Math.abs(r);
  const grow = r > 0;
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(w * h);
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const at = (o: number, i: number) => (horizontal ? o * w + i : i * w + o);
    for (let o = 0; o < outer; o++) {
      // Running count of set pixels in the window [i-k, i+k].
      let count = 0;
      for (let i = 0; i <= Math.min(k, inner - 1); i++) count += src[at(o, i)];
      for (let i = 0; i < inner; i++) {
        const lo = i - k;
        const hi = i + k;
        const span = Math.min(hi, inner - 1) - Math.max(lo, 0) + 1;
        out[at(o, i)] = grow ? (count > 0 ? 1 : 0) : count === span ? 1 : 0;
        if (hi + 1 < inner) count += src[at(o, hi + 1)];
        if (lo >= 0) count -= src[at(o, lo)];
      }
    }
    return out;
  };
  return { w, h, data: pass(pass(m.data, true), false) };
}

export const closeMask = (m: Mask, r: number) => morph(morph(m, r), -r);
export const openMask = (m: Mask, r: number) => morph(morph(m, -r), r);

export interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Connected components (8-connected). Labels start at 1; 0 = background. */
export function components(m: Mask): { labels: Int32Array; comps: Component[] } {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (!data[s] || labels[s]) continue;
    const c: Component = { label: next, area: 0, x0: w, y0: h, x1: -1, y1: -1 };
    labels[s] = next;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const j = yy * w + xx;
          if (data[j] && !labels[j]) {
            labels[j] = next;
            stack.push(j);
          }
        }
      }
    }
    comps.push(c);
    next++;
  }
  return { labels, comps };
}

export function componentMask(labels: Int32Array, w: number, h: number, keep: (label: number) => boolean): Mask {
  return maskWhere(w, h, (i) => labels[i] > 0 && keep(labels[i]));
}

/** Fill every background region that does not touch the border. */
export function fillHoles(m: Mask): Mask {
  const { w, h } = m;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const seed = (i: number) => {
    if (!m.data[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  return maskWhere(w, h, (i) => m.data[i] === 1 || outside[i] === 0);
}

/**
 * Top and bottom set pixel per column of a mask (NaN where the column is empty),
 * in pixel-edge coordinates: top = first row, bottom = last row + 1.
 */
export function columnProfile(m: Mask): { top: Float64Array; bottom: Float64Array } {
  const top = new Float64Array(m.w).fill(NaN);
  const bottom = new Float64Array(m.w).fill(NaN);
  for (let x = 0; x < m.w; x++) {
    for (let y = 0; y < m.h; y++) {
      if (m.data[y * m.w + x]) {
        if (isNaN(top[x])) top[x] = y;
        bottom[x] = y + 1;
      }
    }
  }
  return { top, bottom };
}

/** Ramer–Douglas–Peucker simplification of an open polyline (endpoints kept). */
export function douglasPeucker(pts: readonly Vec[], eps: number): Vec[] {
  if (pts.length <= 2) return pts.map((p) => ({ ...p }));
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a];
    const B = pts[b];
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const L = Math.hypot(dx, dy) || 1e-9;
    let best = -1;
    let bd = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (bd > eps && best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]).map((p) => ({ ...p }));
}
