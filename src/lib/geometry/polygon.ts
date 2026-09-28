import { type BBox, type Vec, bboxOf, cross, dist, sub } from './vec';

/** Signed area (positive = counter-clockwise in a y-up frame). */
export function signedArea(poly: readonly Vec[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export const area = (poly: readonly Vec[]) => Math.abs(signedArea(poly));

export function centroid(poly: readonly Vec[]): Vec {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-12) {
    const b = bboxOf(poly);
    return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/** Even-odd point in polygon test. */
export function pointInPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y) {
      const x = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

export function ensureCCW(poly: readonly Vec[]): Vec[] {
  return signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

/** Remove consecutive duplicates and collinear vertices. */
export function cleanPolygon(poly: readonly Vec[], eps = 1e-9): Vec[] {
  const out: Vec[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > eps) out.push(p);
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const ab = sub(b, a);
      const bc = sub(c, b);
      const scale = Math.max(1e-12, Math.hypot(ab.x, ab.y) * Math.hypot(bc.x, bc.y));
      if (Math.abs(cross(ab, bc)) / scale < 1e-7 && ab.x * bc.x + ab.y * bc.y > 0) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function convexHull(points: readonly Vec[]): Vec[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: Vec[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(p, lower[lower.length - 1])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(p, upper[upper.length - 1])) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return [...lower, ...upper];
}

export interface OrientedRect {
  center: Vec;
  /** Unit vector along the first side. */
  axis: Vec;
  /** Length along `axis`. */
  width: number;
  /** Length perpendicular to `axis`. */
  height: number;
  corners: Vec[];
}

/** Minimum-area enclosing rectangle (rotating calipers over the hull edges). */
export function minAreaRect(points: readonly Vec[]): OrientedRect | null {
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  let best: OrientedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const e = sub(b, a);
    const l = Math.hypot(e.x, e.y);
    if (l < 1e-12) continue;
    const ux = { x: e.x / l, y: e.y / l };
    const uy = { x: -ux.y, y: ux.x };
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const pu = p.x * ux.x + p.y * ux.y;
      const pv = p.x * uy.x + p.y * uy.y;
      minU = Math.min(minU, pu);
      maxU = Math.max(maxU, pu);
      minV = Math.min(minV, pv);
      maxV = Math.max(maxV, pv);
    }
    const w = maxU - minU;
    const h = maxV - minV;
    if (w * h < bestArea) {
      bestArea = w * h;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const center = { x: ux.x * cu + uy.x * cv, y: ux.y * cu + uy.y * cv };
      const corner = (su: number, sv: number): Vec => ({
        x: ux.x * su + uy.x * sv,
        y: ux.y * su + uy.y * sv,
      });
      best = {
        center,
        axis: ux,
        width: w,
        height: h,
        corners: [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)],
      };
    }
  }
  return best;
}

/**
 * Inset a counter-clockwise polygon, moving each edge inward by its own distance
 * (0 keeps the edge in place). Returns null if the result degenerates.
 */
export function insetPolygon(poly: readonly Vec[], distances: readonly number[]): Vec[] | null {
  const n = poly.length;
  if (n < 3) return null;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const e = sub(q, p);
    const l = Math.hypot(e.x, e.y) || 1;
    const nx = -e.y / l;
    const ny = e.x / l;
    const d = distances[i] ?? 0;
    return { p: { x: p.x + nx * d, y: p.y + ny * d }, dir: { x: e.x / l, y: e.y / l } };
  });
  const out: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const prev = lines[(i + n - 1) % n];
    const cur = lines[i];
    const den = cross(prev.dir, cur.dir);
    if (Math.abs(den) < 1e-9) {
      out.push(cur.p);
      continue;
    }
    const t = cross(sub(cur.p, prev.p), cur.dir) / den;
    out.push({ x: prev.p.x + prev.dir.x * t, y: prev.p.y + prev.dir.y * t });
  }
  const a0 = signedArea(poly);
  const a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) > Math.abs(a0) + 1e-9 || Math.abs(a1) < 1e-9) return null;
  return out;
}

export function bboxOfPoly(poly: readonly Vec[]): BBox {
  return bboxOf(poly);
}

/** Distance from p to segment ab. */
export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = ab.x * ab.x + ab.y * ab.y;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}
