export interface Vec {
  x: number;
  y: number;
}

export type Polyline = Vec[];

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const norm = (a: Vec): Vec => {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
/** Left-hand perpendicular (rotate +90° in a y-up frame). */
export const perp = (a: Vec): Vec => ({ x: -a.y, y: a.x });
export const rotate = (a: Vec, angle: number, about: Vec = { x: 0, y: 0 }): Vec => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = a.x - about.x;
  const dy = a.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
};

export function bboxOf(points: readonly Vec[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

export function bboxUnion(a: BBox | null, b: BBox): BBox {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function bboxOverlap(a: BBox, b: BBox, eps = 0): boolean {
  return a.x0 <= b.x1 + eps && b.x0 <= a.x1 + eps && a.y0 <= b.y1 + eps && b.y0 <= a.y1 + eps;
}

export const bboxW = (b: BBox) => b.x1 - b.x0;
export const bboxH = (b: BBox) => b.y1 - b.y0;

/** Rectangle as a closed polygon (counter-clockwise in a y-up frame). */
export function rectPoly(x0: number, y0: number, x1: number, y1: number): Vec[] {
  const ax = Math.min(x0, x1);
  const bx = Math.max(x0, x1);
  const ay = Math.min(y0, y1);
  const by = Math.max(y0, y1);
  return [
    { x: ax, y: ay },
    { x: bx, y: ay },
    { x: bx, y: by },
    { x: ax, y: by },
  ];
}

/** Closed polyline for a polygon (repeats the first point). */
export function closed(poly: readonly Vec[]): Vec[] {
  if (poly.length === 0) return [];
  return [...poly, poly[0]];
}

export function circlePoly(c: Vec, r: number, segments = 48, start = 0, end = Math.PI * 2): Vec[] {
  const pts: Vec[] = [];
  const full = Math.abs(end - start - Math.PI * 2) < 1e-9;
  const n = Math.max(3, segments);
  const count = full ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const a = start + ((end - start) * i) / n;
    pts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return pts;
}

/** Number of segments so a circle of radius r (in paper mm) deviates < tol mm from its chords. */
export function segmentsForRadius(rMm: number, tolMm = 0.03): number {
  if (rMm <= tolMm) return 8;
  const theta = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolMm / rMm)));
  return Math.min(256, Math.max(12, Math.ceil((Math.PI * 2) / theta)));
}
