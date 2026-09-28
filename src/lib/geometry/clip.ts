import { pointInPolygon } from './polygon';
import { type BBox, type Polyline, type Vec, bboxOf } from './vec';

/** A polygon with a cached bounding box, used as a clip region. */
export interface Region {
  poly: Vec[];
  bbox: BBox;
}

export function region(poly: Vec[]): Region {
  return { poly, bbox: bboxOf(poly) };
}

const inBox = (p: Vec, b: BBox) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

function insideAny(p: Vec, regions: readonly Region[]): boolean {
  for (const r of regions) {
    if (inBox(p, r.bbox) && pointInPolygon(p, r.poly)) return true;
  }
  return false;
}

/**
 * Clip a polyline so that only the parts inside at least one `include` region
 * (or everywhere, when `include` is null) and outside every `exclude` region remain.
 * Handles concave polygons; boundaries are resolved by midpoint tests.
 */
export function clipPolyline(line: Polyline, include: readonly Region[] | null, exclude: readonly Region[]): Polyline[] {
  const out: Polyline[] = [];
  let current: Polyline | null = null;
  const all = include ? [...include, ...exclude] : exclude;

  for (let s = 0; s + 1 < line.length; s++) {
    const a = line[s];
    const b = line[s + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) continue;
    const sb: BBox = {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y),
    };
    const ts: number[] = [0, 1];
    for (const r of all) {
      const rb = r.bbox;
      if (rb.x0 > sb.x1 || rb.x1 < sb.x0 || rb.y0 > sb.y1 || rb.y1 < sb.y0) continue;
      const poly = r.poly;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const p = poly[j];
        const q = poly[i];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const den = dx * ey - dy * ex;
        if (den === 0) continue;
        const wx = p.x - a.x;
        const wy = p.y - a.y;
        const t = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (t > 0 && t < 1 && u >= -1e-12 && u <= 1 + 1e-12) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      const m = { x: a.x + dx * tm, y: a.y + dy * tm };
      const keep = (include === null || insideAny(m, include)) && !insideAny(m, exclude);
      if (keep) {
        const p0 = { x: a.x + dx * t0, y: a.y + dy * t0 };
        const p1 = { x: a.x + dx * t1, y: a.y + dy * t1 };
        if (current) {
          const last = current[current.length - 1];
          if (Math.abs(last.x - p0.x) < 1e-9 && Math.abs(last.y - p0.y) < 1e-9) {
            current.push(p1);
            continue;
          }
          out.push(current);
        }
        current = [p0, p1];
      } else if (current) {
        out.push(current);
        current = null;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

export function clipPolylines(lines: readonly Polyline[], include: readonly Region[] | null, exclude: readonly Region[]): Polyline[] {
  const out: Polyline[] = [];
  for (const l of lines) out.push(...clipPolyline(l, include, exclude));
  return out;
}

/**
 * Parallel hatch lines covering `bbox`, spaced `spacing` apart, with direction `angle`
 * (radians, 0 = along +x). Lines pass through `anchor` + k * spacing * normal.
 */
export function hatchLines(bbox: BBox, spacing: number, angle = 0, anchor: Vec = { x: 0, y: 0 }): Polyline[] {
  if (!(spacing > 0)) return [];
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const nrm = { x: -dir.y, y: dir.x };
  const corners = [
    { x: bbox.x0, y: bbox.y0 },
    { x: bbox.x1, y: bbox.y0 },
    { x: bbox.x1, y: bbox.y1 },
    { x: bbox.x0, y: bbox.y1 },
  ];
  let minN = Infinity;
  let maxN = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  for (const c of corners) {
    const n = (c.x - anchor.x) * nrm.x + (c.y - anchor.y) * nrm.y;
    const d = (c.x - anchor.x) * dir.x + (c.y - anchor.y) * dir.y;
    minN = Math.min(minN, n);
    maxN = Math.max(maxN, n);
    minD = Math.min(minD, d);
    maxD = Math.max(maxD, d);
  }
  const lines: Polyline[] = [];
  const k0 = Math.ceil(minN / spacing - 1e-9);
  const k1 = Math.floor(maxN / spacing + 1e-9);
  if (k1 - k0 > 20000) return [];
  for (let k = k0; k <= k1; k++) {
    const o = k * spacing;
    const base = { x: anchor.x + nrm.x * o, y: anchor.y + nrm.y * o };
    lines.push([
      { x: base.x + dir.x * (minD - 1), y: base.y + dir.y * (minD - 1) },
      { x: base.x + dir.x * (maxD + 1), y: base.y + dir.y * (maxD + 1) },
    ]);
  }
  return lines;
}
