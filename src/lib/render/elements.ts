import { type Region, clipPolyline, region } from '../geometry/clip';
import { insetPolygon } from '../geometry/polygon';
import { type Polyline, type Vec, bboxOf, circlePoly, closed, rectPoly } from '../geometry/vec';
import type {
  ChimneyEl,
  ColumnEl,
  DoorEl,
  GableEl,
  GarageEl,
  GridStyle,
  RoofEl,
  VentEl,
  WallEl,
  WindowEl,
  WindowStyle,
} from '../model/types';
import type { WorldEl, WRect } from '../model/world';
import { IN, type PatternCtx, roofPattern, thinFactor, wallPattern } from './patterns';
import type { Layer, Stroke } from './types';

export interface RenderCtx extends PatternCtx {
  /** Course datum so siding lines line up across walls (feet above grade). */
  courseAnchorY: number;
}

export interface ElementOutput {
  strokes: Stroke[];
  /** Polygons that hide anything behind this element. */
  occluders: Vec[][];
}

const S = (layer: Layer, pts: Vec[]): Stroke => ({ layer, pts });
const rectLine = (x0: number, y0: number, x1: number, y1: number): Vec[] => closed(rectPoly(x0, y0, x1, y1));
const hline = (x0: number, x1: number, y: number): Vec[] => [
  { x: x0, y },
  { x: x1, y },
];
const vline = (x: number, y0: number, y1: number): Vec[] => [
  { x, y: y0 },
  { x, y: y1 },
];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const inset = (b: Box, d: number, dy = d): Box => ({ x0: b.x0 + d, y0: b.y0 + dy, x1: b.x1 - d, y1: b.y1 - dy });
const bw = (b: Box) => b.x1 - b.x0;
const bh = (b: Box) => b.y1 - b.y0;
const valid = (b: Box) => b.x1 - b.x0 > 1e-4 && b.y1 - b.y0 > 1e-4;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function ellipseArc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

function arcSegments(r: number, ctx: PatternCtx) {
  return clamp(Math.ceil(r * ctx.mmPerFt * 3), 12, 64);
}

/** Rectangle with an elliptical arch on top (counter-clockwise). */
function archTopPoly(b: Box, archRise: number, ctx: PatternCtx): Vec[] {
  const rx = bw(b) / 2;
  const ry = Math.min(archRise, bh(b));
  const cy = b.y1 - ry;
  const arc = ellipseArc((b.x0 + b.x1) / 2, cy, rx, ry, 0, Math.PI, arcSegments(rx, ctx));
  return [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, ...arc.slice(0, arc.length - 1), { x: b.x0, y: cy }];
}

function ellipsePoly(b: Box, ctx: PatternCtx): Vec[] {
  const rx = bw(b) / 2;
  const ry = bh(b) / 2;
  const n = arcSegments(Math.max(rx, ry), ctx) * 2;
  return ellipseArc((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, rx, ry, 0, Math.PI * 2, n).slice(0, n);
}

function halfRoundPoly(b: Box, ctx: PatternCtx): Vec[] {
  const rx = bw(b) / 2;
  const arc = ellipseArc((b.x0 + b.x1) / 2, b.y0, rx, bh(b), 0, Math.PI, arcSegments(rx, ctx));
  return arc;
}

function octagonPoly(b: Box): Vec[] {
  const c = Math.min(bw(b), bh(b)) * (1 - 1 / Math.SQRT2);
  return [
    { x: b.x0 + c, y: b.y0 },
    { x: b.x1 - c, y: b.y0 },
    { x: b.x1, y: b.y0 + c },
    { x: b.x1, y: b.y1 - c },
    { x: b.x1 - c, y: b.y1 },
    { x: b.x0 + c, y: b.y1 },
    { x: b.x0, y: b.y1 - c },
    { x: b.x0, y: b.y0 + c },
  ];
}

function trianglePoly(b: Box): Vec[] {
  return [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: (b.x0 + b.x1) / 2, y: b.y1 },
  ];
}

function linesInside(lines: Vec[][], shape: Vec[]): Polyline[] {
  const r = region(shape);
  return lines.flatMap((l) => clipPolyline(l, [r], []));
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function gridLines(g: Box, cols: number, rows: number): Vec[][] {
  const out: Vec[][] = [];
  for (let i = 1; i < cols; i++) out.push(vline(g.x0 + (bw(g) * i) / cols, g.y0, g.y1));
  for (let j = 1; j < rows; j++) out.push(hline(g.x0, g.x1, g.y0 + (bh(g) * j) / rows));
  return out;
}

function prairieLines(g: Box): Vec[][] {
  const p = Math.min(0.14 * Math.min(bw(g), bh(g)), 3.5 * IN);
  return [hline(g.x0, g.x1, g.y1 - p), hline(g.x0, g.x1, g.y0 + p), vline(g.x0 + p, g.y0, g.y1), vline(g.x1 - p, g.y0, g.y1)];
}

function autoCols(glassW: number, set: number) {
  return set > 0 ? set : clamp(Math.round(glassW / 0.95), 1, 6);
}
function autoRows(glassH: number, set: number) {
  return set > 0 ? set : clamp(Math.round(glassH / 1.1), 1, 5);
}

function glassWithGrid(out: Stroke[], glass: Box, grid: GridStyle, el: WindowEl, applyGrid: boolean, ctx: PatternCtx) {
  if (!valid(glass)) return;
  out.push(S('hatch', rectLine(glass.x0, glass.y0, glass.x1, glass.y1)));
  if (!applyGrid || grid === 'none') return;
  if (grid === 'prairie') {
    for (const l of prairieLines(glass)) out.push(S('hatch', l));
    return;
  }
  const cols = autoCols(bw(glass), el.gridCols);
  const rows = autoRows(bh(glass), el.gridRows);
  if (thinFactor(bw(glass) / cols, ctx) > 1 || thinFactor(bh(glass) / rows, ctx) > 1) return;
  for (const l of gridLines(glass, cols, rows)) out.push(S('hatch', l));
}

function windowUnit(out: Stroke[], U: Box, style: WindowStyle, el: WindowEl, ctx: PatternCtx) {
  const f = Math.min(1.25 * IN, bw(U) * 0.06);
  const s = Math.min(2 * IN, bw(U) * 0.09, bh(U) * 0.06);
  out.push(S('detail', rectLine(U.x0, U.y0, U.x1, U.y1)));
  const frame = inset(U, f);
  if (!valid(frame)) return;
  switch (style) {
    case 'double-hung': {
      const ym = (frame.y0 + frame.y1) / 2;
      const upper = { x0: frame.x0, y0: ym, x1: frame.x1, y1: frame.y1 };
      const lower = { x0: frame.x0, y0: frame.y0, x1: frame.x1, y1: ym };
      out.push(S('detail', rectLine(upper.x0, upper.y0, upper.x1, upper.y1)));
      out.push(S('detail', rectLine(lower.x0, lower.y0, lower.x1, lower.y1)));
      glassWithGrid(out, { x0: upper.x0 + s, y0: upper.y0 + s * 0.7, x1: upper.x1 - s, y1: upper.y1 - s }, el.grid, el, true, ctx);
      glassWithGrid(out, { x0: lower.x0 + s, y0: lower.y0 + s * 1.3, x1: lower.x1 - s, y1: lower.y1 - s * 0.7 }, el.grid, el, el.grid === 'full', ctx);
      break;
    }
    case 'slider': {
      const xm = (frame.x0 + frame.x1) / 2;
      const left = { x0: frame.x0, y0: frame.y0, x1: xm + f / 2, y1: frame.y1 };
      const right = { x0: xm - f / 2, y0: frame.y0, x1: frame.x1, y1: frame.y1 };
      for (const sash of [left, right]) {
        out.push(S('detail', rectLine(sash.x0, sash.y0, sash.x1, sash.y1)));
        glassWithGrid(out, inset(sash, s), el.grid, el, el.grid !== 'none', ctx);
      }
      break;
    }
    default: {
      out.push(S('detail', rectLine(frame.x0, frame.y0, frame.x1, frame.y1)));
      glassWithGrid(out, inset(frame, s), el.grid, el, el.grid !== 'none', ctx);
    }
  }
}

function renderWindow(el: WindowEl, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const occ: Vec[][] = [];
  const box: Box = { ...r };
  const minSide = Math.min(bw(box), bh(box));
  const t = el.trim ? Math.min(3.5 * IN, 0.13 * minSide) : 0;
  const s = Math.min(2 * IN, minSide * 0.08);
  const style = el.style;

  if (style === 'round' || style === 'octagon' || style === 'half-round' || style === 'arch-top') {
    const shape = (b: Box): Vec[] =>
      style === 'round' ? ellipsePoly(b, ctx) : style === 'octagon' ? octagonPoly(b) : style === 'half-round' ? halfRoundPoly(b, ctx) : archTopPoly(b, bw(b) / 2, ctx);
    const outer = shape(box);
    occ.push(outer);
    out.push(S('detail', closed(outer)));
    const innerBox = style === 'half-round' ? { x0: box.x0 + t, y0: box.y0 + t * 0.6, x1: box.x1 - t, y1: box.y1 - t } : inset(box, t);
    if (t > 0 && valid(innerBox)) out.push(S('detail', closed(shape(innerBox))));
    const glassBox = style === 'half-round' ? { x0: innerBox.x0 + s, y0: innerBox.y0 + s * 0.5, x1: innerBox.x1 - s, y1: innerBox.y1 - s } : inset(innerBox, s);
    if (!valid(glassBox)) return { strokes: out, occluders: occ };
    const glass = shape(glassBox);
    out.push(S('hatch', closed(glass)));
    if (el.grid !== 'none') {
      const cx = (glassBox.x0 + glassBox.x1) / 2;
      const cy = (glassBox.y0 + glassBox.y1) / 2;
      if (style === 'half-round') {
        const hubR = bw(glassBox) * 0.16;
        const hub = ellipseArc(cx, glassBox.y0, hubR, hubR * (bh(glassBox) / (bw(glassBox) / 2)), 0, Math.PI, 16);
        out.push(S('hatch', hub));
        const rays: Vec[][] = [];
        for (const a of [30, 60, 90, 120, 150]) {
          const rad = (a * Math.PI) / 180;
          rays.push([
            { x: cx + Math.cos(rad) * hubR, y: glassBox.y0 + Math.sin(rad) * hubR * (bh(glassBox) / (bw(glassBox) / 2)) },
            { x: cx + Math.cos(rad) * bw(glassBox), y: glassBox.y0 + Math.sin(rad) * bh(glassBox) * 2 },
          ]);
        }
        for (const l of linesInside(rays, glass)) out.push(S('hatch', l));
      } else if (style === 'arch-top') {
        const cols = autoCols(bw(glassBox), el.gridCols);
        const lines = gridLines(glassBox, cols, 1);
        const spring = glassBox.y1 - bw(glassBox) / 2;
        if (spring > glassBox.y0) lines.push(hline(glassBox.x0, glassBox.x1, spring));
        const rows = el.gridRows > 0 ? el.gridRows : Math.max(1, Math.round((spring - glassBox.y0) / 1.1));
        for (let j = 1; j < rows; j++) lines.push(hline(glassBox.x0, glassBox.x1, glassBox.y0 + ((spring - glassBox.y0) * j) / rows));
        for (const l of linesInside(lines, glass)) out.push(S('hatch', l));
      } else {
        for (const l of linesInside([hline(glassBox.x0, glassBox.x1, cy), vline(cx, glassBox.y0, glassBox.y1)], glass)) out.push(S('hatch', l));
      }
    }
  } else {
    occ.push(rectPoly(box.x0, box.y0, box.x1, box.y1));
    out.push(S('detail', rectLine(box.x0, box.y0, box.x1, box.y1)));
    const opening = inset(box, t);
    if (valid(opening)) {
      const n = clamp(Math.round(el.units) || 1, 1, 8);
      const mull = n > 1 ? Math.max(t * 0.7, 2 * IN) : 0;
      const uw = (bw(opening) - mull * (n - 1)) / n;
      if (uw > 0) {
        for (let i = 0; i < n; i++) {
          const x0 = opening.x0 + i * (uw + mull);
          windowUnit(out, { x0, y0: opening.y0, x1: x0 + uw, y1: opening.y1 }, style, el, ctx);
        }
      }
    }
  }

  if (el.trim && el.sill && style !== 'round' && style !== 'octagon') {
    const sill = { x0: box.x0 - 1.25 * IN, y0: box.y0 - 1.75 * IN, x1: box.x1 + 1.25 * IN, y1: box.y0 };
    out.push(S('detail', rectLine(sill.x0, sill.y0, sill.x1, sill.y1)));
    occ.push(rectPoly(sill.x0, sill.y0, sill.x1, sill.y1));
  }
  if (el.header && style !== 'round' && style !== 'octagon' && style !== 'half-round') {
    const top = style === 'arch-top' ? box.y1 : box.y1;
    const cap = { x0: box.x0 - 2 * IN, y0: top, x1: box.x1 + 2 * IN, y1: top + 2.5 * IN };
    out.push(S('detail', rectLine(cap.x0, cap.y0, cap.x1, cap.y1)));
    out.push(S('detail', hline(cap.x0, cap.x1, top + 1.5 * IN)));
    occ.push(rectPoly(cap.x0, cap.y0, cap.x1, cap.y1));
  }
  if (el.shutters && style !== 'round' && style !== 'octagon' && style !== 'half-round') {
    const n = clamp(Math.round(el.units) || 1, 1, 8);
    const sw = clamp((bw(box) - 2 * t) / n / 2, 0.8, 2.2);
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? box.x0 - sw - 0.5 * IN : box.x1 + 0.5 * IN;
      const sh = { x0, y0: box.y0, x1: x0 + sw, y1: box.y1 };
      out.push(S('detail', rectLine(sh.x0, sh.y0, sh.x1, sh.y1)));
      occ.push(rectPoly(sh.x0, sh.y0, sh.x1, sh.y1));
      const inner = inset(sh, Math.min(2 * IN, sw * 0.15), Math.min(2.5 * IN, bh(sh) * 0.05));
      if (!valid(inner)) continue;
      out.push(S('hatch', rectLine(inner.x0, inner.y0, inner.x1, inner.y1)));
      const mid = (inner.y0 + inner.y1) / 2;
      out.push(S('hatch', hline(inner.x0, inner.x1, mid - 1.5 * IN)));
      out.push(S('hatch', hline(inner.x0, inner.x1, mid + 1.5 * IN)));
      if (ctx.detail !== 'low') {
        const lp = 2.5 * IN * thinFactor(2.5 * IN, ctx);
        for (let y = inner.y0 + lp; y < inner.y1 - lp / 3; y += lp) {
          if (Math.abs(y - mid) < 1.5 * IN + lp / 3) continue;
          out.push(S('hatch', hline(inner.x0, inner.x1, y)));
        }
      }
    }
  }
  return { strokes: out, occluders: occ };
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

function raisedPanel(out: Stroke[], p: Box, ctx: PatternCtx) {
  if (!valid(p)) return;
  out.push(S('hatch', rectLine(p.x0, p.y0, p.x1, p.y1)));
  const d = Math.min(1.5 * IN, bw(p) * 0.18, bh(p) * 0.18);
  if (ctx.detail !== 'low' && thinFactor(d, ctx) === 1) {
    const q = inset(p, d);
    if (valid(q)) out.push(S('hatch', rectLine(q.x0, q.y0, q.x1, q.y1)));
  }
}

function glassPane(out: Stroke[], g: Box, cols: number, rows: number, ctx: PatternCtx) {
  if (!valid(g)) return;
  out.push(S('hatch', rectLine(g.x0, g.y0, g.x1, g.y1)));
  if (thinFactor(bw(g) / Math.max(1, cols), ctx) > 1 || thinFactor(bh(g) / Math.max(1, rows), ctx) > 1) return;
  for (const l of gridLines(g, cols, rows)) out.push(S('hatch', l));
}

function doorLeaf(out: Stroke[], d: Box, style: DoorEl['style'], knobSide: 'left' | 'right' | 'none', ctx: PatternCtx) {
  out.push(S('detail', rectLine(d.x0, d.y0, d.x1, d.y1)));
  const W = bw(d);
  const H = bh(d);
  const stile = Math.min(4.5 * IN, W * 0.15);
  const top = Math.min(4.5 * IN, H * 0.07);
  const bottom = Math.min(9 * IN, H * 0.12);
  switch (style) {
    case 'six-panel':
    case 'double': {
      const mid = Math.min(4 * IN, W * 0.12);
      const colW = (W - 2 * stile - mid) / 2;
      const inner = { x0: d.x0 + stile, x1: d.x1 - stile };
      const hTop = (H - top - bottom) * 0.2;
      const lock = Math.min(7 * IN, H * 0.09);
      const hBot = (H - top - bottom - hTop - lock - 2 * top) * 0.42;
      const rows: [number, number][] = [];
      const y3 = d.y1 - top;
      rows.push([y3 - hTop, y3]);
      const yMidTop = y3 - hTop - top;
      const yMidBot = d.y0 + bottom + hBot + lock;
      rows.push([yMidBot, yMidTop]);
      rows.push([d.y0 + bottom, d.y0 + bottom + hBot]);
      for (const [y0, y1] of rows) {
        raisedPanel(out, { x0: inner.x0, y0, x1: inner.x0 + colW, y1 }, ctx);
        raisedPanel(out, { x0: inner.x1 - colW, y0, x1: inner.x1, y1 }, ctx);
      }
      break;
    }
    case 'craftsman': {
      const liteH = H * 0.3;
      const g = { x0: d.x0 + stile, y0: d.y1 - top - liteH, x1: d.x1 - stile, y1: d.y1 - top };
      glassPane(out, g, 3, 1, ctx);
      const shelfY = g.y0 - 1.5 * IN;
      out.push(S('detail', rectLine(d.x0 + stile * 0.6, shelfY - 1.25 * IN, d.x1 - stile * 0.6, shelfY)));
      const panelTop = shelfY - 1.25 * IN - top;
      const n = 3;
      const gap = Math.min(3 * IN, W * 0.08);
      const pw = (W - 2 * stile - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const x0 = d.x0 + stile + i * (pw + gap);
        raisedPanel(out, { x0, y0: d.y0 + bottom, x1: x0 + pw, y1: panelTop }, ctx);
      }
      break;
    }
    case 'half-lite': {
      const g = { x0: d.x0 + stile, y0: d.y0 + H * 0.5, x1: d.x1 - stile, y1: d.y1 - top };
      glassPane(out, g, 2, 3, ctx);
      const mid = Math.min(4 * IN, W * 0.12);
      const colW = (W - 2 * stile - mid) / 2;
      const y1 = g.y0 - top * 1.5;
      raisedPanel(out, { x0: d.x0 + stile, y0: d.y0 + bottom, x1: d.x0 + stile + colW, y1 }, ctx);
      raisedPanel(out, { x0: d.x1 - stile - colW, y0: d.y0 + bottom, x1: d.x1 - stile, y1 }, ctx);
      break;
    }
    case 'full-lite':
    case 'french': {
      const g = { x0: d.x0 + stile, y0: d.y0 + bottom, x1: d.x1 - stile, y1: d.y1 - top };
      glassPane(out, g, style === 'french' ? 2 : 1, style === 'french' ? 5 : 1, ctx);
      break;
    }
    case 'flush':
      break;
  }
  if (knobSide !== 'none') {
    const kx = knobSide === 'right' ? d.x1 - Math.min(3.5 * IN, W * 0.12) : d.x0 + Math.min(3.5 * IN, W * 0.12);
    const knob = circlePoly({ x: kx, y: d.y0 + 3 }, Math.max(1.2 * IN, 0.25 / ctx.mmPerFt), 12);
    out.push(S('detail', closed(knob)));
  }
}

function renderDoor(el: DoorEl, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  out.push(S('detail', rectLine(box.x0, box.y0, box.x1, box.y1)));
  const t = el.trim ? Math.min(4.5 * IN, bw(box) * 0.07) : 0;
  let o: Box = { x0: box.x0 + t, y0: box.y0, x1: box.x1 - t, y1: box.y1 - t };
  if (!valid(o)) return { strokes: out, occluders: [rectPoly(box.x0, box.y0, box.x1, box.y1)] };
  if (t > 0) out.push(S('detail', [{ x: o.x0, y: o.y0 }, { x: o.x0, y: o.y1 }, { x: o.x1, y: o.y1 }, { x: o.x1, y: o.y0 }]));

  if (el.transom) {
    const th = clamp(bh(o) * 0.17, 1.0, 1.6);
    const tr = { x0: o.x0, y0: o.y1 - th, x1: o.x1, y1: o.y1 };
    const mullion = Math.min(2.5 * IN, th * 0.2);
    out.push(S('detail', hline(o.x0, o.x1, tr.y0)));
    out.push(S('detail', hline(o.x0, o.x1, tr.y0 - mullion)));
    const cols = clamp(Math.round(bw(tr) / 1.0), 2, 8);
    glassPane(out, inset(tr, Math.min(2 * IN, th * 0.15)), cols, 1, ctx);
    o = { ...o, y1: tr.y0 - mullion };
  }
  const slW = clamp(bw(o) * 0.2, 0.8, 1.35);
  const mull = Math.min(2 * IN, slW * 0.12);
  const drawSidelight = (x0: number, x1: number) => {
    out.push(S('detail', rectLine(x0, o.y0, x1, o.y1)));
    const f = Math.min(2 * IN, (x1 - x0) * 0.16);
    const panelTop = o.y0 + Math.min(1.6, bh(o) * 0.24);
    raisedPanel(out, { x0: x0 + f, y0: o.y0 + f * 1.5, x1: x1 - f, y1: panelTop }, ctx);
    glassPane(out, { x0: x0 + f, y0: panelTop + f, x1: x1 - f, y1: o.y1 - f }, 1, Math.max(1, Math.round((o.y1 - panelTop) / 1.2)), ctx);
  };
  if ((el.sidelights === 'left' || el.sidelights === 'both') && bw(o) > slW * 2) {
    drawSidelight(o.x0, o.x0 + slW);
    o = { ...o, x0: o.x0 + slW + mull };
  }
  if ((el.sidelights === 'right' || el.sidelights === 'both') && bw(o) > slW * 2) {
    drawSidelight(o.x1 - slW, o.x1);
    o = { ...o, x1: o.x1 - slW - mull };
  }
  if (el.style === 'double' || el.style === 'french') {
    const xm = (o.x0 + o.x1) / 2;
    doorLeaf(out, { ...o, x1: xm }, el.style, 'right', ctx);
    doorLeaf(out, { ...o, x0: xm }, el.style, 'left', ctx);
  } else {
    doorLeaf(out, o, el.style, 'right', ctx);
  }
  return { strokes: out, occluders: [rectPoly(box.x0, box.y0, box.x1, box.y1)] };
}

// ---------------------------------------------------------------------------
// Garage doors
// ---------------------------------------------------------------------------

function renderGarage(el: GarageEl, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  out.push(S('detail', rectLine(box.x0, box.y0, box.x1, box.y1)));
  const t = el.trim ? Math.min(5.5 * IN, bw(box) * 0.05, bh(box) * 0.08) : 0;
  const o: Box = { x0: box.x0 + t, y0: box.y0, x1: box.x1 - t, y1: box.y1 - t };
  const occluders = [rectPoly(box.x0, box.y0, box.x1, box.y1)];
  if (!valid(o)) return { strokes: out, occluders };
  if (t > 0) out.push(S('detail', [{ x: o.x0, y: o.y0 }, { x: o.x0, y: o.y1 }, { x: o.x1, y: o.y1 }, { x: o.x1, y: o.y0 }]));
  const n = clamp(Math.round(el.sections) || 4, 1, 8);
  const sh = bh(o) / n;
  for (let i = 1; i < n; i++) out.push(S('detail', hline(o.x0, o.x1, o.y0 + sh * i)));
  const W = bw(o);
  const autoPanels = el.style === 'long-panel' ? Math.max(2, Math.round(W / 4)) : el.style === 'full-view' ? Math.max(2, Math.round(W / 2.6)) : Math.max(2, Math.round(W / 1.95));
  const m = clamp(el.panels > 0 ? el.panels : autoPanels, 1, 16);

  if (el.style === 'carriage') {
    const xm = (o.x0 + o.x1) / 2;
    out.push(S('detail', vline(xm, o.y0, o.y1)));
    const board = 6 * IN * thinFactor(6 * IN, ctx);
    for (const [a, b] of [
      [o.x0, xm],
      [xm, o.x1],
    ]) {
      const winTop = el.windows ? o.y1 - sh * 0.95 : o.y1;
      for (let x = a + board; x < b - board / 3; x += board) out.push(S('hatch', vline(x, o.y0, winTop)));
      if (el.windows) {
        const half = { x0: a + 3 * IN, y0: o.y1 - sh * 0.9, x1: b - 3 * IN, y1: o.y1 - 3 * IN };
        const k = 2;
        const gap = 3 * IN;
        const ww = (bw(half) - gap * (k - 1)) / k;
        for (let i = 0; i < k; i++) {
          const x0 = half.x0 + i * (ww + gap);
          glassPane(out, { x0, y0: half.y0, x1: x0 + ww, y1: half.y1 }, 2, 2, ctx);
        }
        out.push(S('hatch', hline(a, b, half.y0 - 2 * IN)));
      }
      // Strap hinges and handles.
      for (const hy of [o.y0 + bh(o) * 0.2, o.y0 + bh(o) * 0.55]) {
        const outerX = a === o.x0 ? a : b;
        const dir = a === o.x0 ? 1 : -1;
        const len = (b - a) * 0.28;
        out.push(S('detail', rectLine(Math.min(outerX, outerX + dir * len), hy - 1.5 * IN, Math.max(outerX, outerX + dir * len), hy + 1.5 * IN)));
      }
    }
    out.push(S('detail', rectLine(xm - 6 * IN, o.y0 + bh(o) * 0.42, xm - 4.5 * IN, o.y0 + bh(o) * 0.42 + 8 * IN)));
    out.push(S('detail', rectLine(xm + 4.5 * IN, o.y0 + bh(o) * 0.42, xm + 6 * IN, o.y0 + bh(o) * 0.42 + 8 * IN)));
    return { strokes: out, occluders };
  }

  if (el.style === 'ribbed') {
    const pitch = 8 * IN * thinFactor(8 * IN, ctx);
    for (let x = o.x0 + pitch; x < o.x1 - pitch / 3; x += pitch) out.push(S('hatch', vline(x, o.y0, o.y1)));
    return { strokes: out, occluders };
  }
  if (el.style === 'flush') {
    if (el.windows) {
      const k = Math.max(2, Math.round(W / 2));
      const gap = 4 * IN;
      const ww = (W - 2 * gap - gap * (k - 1)) / k;
      for (let i = 0; i < k; i++) {
        const x0 = o.x0 + gap + i * (ww + gap);
        glassPane(out, { x0, y0: o.y1 - sh * 0.75, x1: x0 + ww, y1: o.y1 - sh * 0.25 }, 1, 1, ctx);
      }
    }
    return { strokes: out, occluders };
  }

  const mx = Math.min(3 * IN, W / m / 6);
  const my = Math.min(3 * IN, sh / 5);
  const pw = (W - mx * (m + 1)) / m;
  for (let s = 0; s < n; s++) {
    const y0 = o.y0 + s * sh + my;
    const y1 = o.y0 + (s + 1) * sh - my;
    const isTop = s === n - 1;
    for (let i = 0; i < m; i++) {
      const x0 = o.x0 + mx + i * (pw + mx);
      const p = { x0, y0, x1: x0 + pw, y1 };
      if (el.style === 'full-view' || (isTop && el.windows)) glassPane(out, p, 1, 1, ctx);
      else raisedPanel(out, p, ctx);
    }
  }
  return { strokes: out, occluders };
}

// ---------------------------------------------------------------------------
// Small elements
// ---------------------------------------------------------------------------

function renderVent(el: VentEl, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  const shape = (b: Box): Vec[] =>
    el.shape === 'round'
      ? ellipsePoly(b, ctx)
      : el.shape === 'octagon'
        ? octagonPoly(b)
        : el.shape === 'half-round'
          ? halfRoundPoly(b, ctx)
          : el.shape === 'triangle'
            ? trianglePoly(b)
            : rectPoly(b.x0, b.y0, b.x1, b.y1);
  const outer = shape(box);
  out.push(S('detail', closed(outer)));
  const t = Math.min(2.5 * IN, Math.min(bw(box), bh(box)) * 0.14);
  const innerBox = el.shape === 'triangle' ? { x0: box.x0 + t * 1.8, y0: box.y0 + t, x1: box.x1 - t * 1.8, y1: box.y1 - t * 1.8 } : el.shape === 'half-round' ? { x0: box.x0 + t, y0: box.y0 + t * 0.6, x1: box.x1 - t, y1: box.y1 - t } : inset(box, t);
  if (valid(innerBox)) {
    const inner = shape(innerBox);
    out.push(S('detail', closed(inner)));
    const pitch = 2.5 * IN * thinFactor(2.5 * IN, ctx) * (ctx.detail === 'low' ? 1.5 : 1);
    const lines: Vec[][] = [];
    for (let y = innerBox.y0 + pitch; y < innerBox.y1 - pitch / 4; y += pitch) lines.push(hline(innerBox.x0 - 1, innerBox.x1 + 1, y));
    for (const l of linesInside(lines, inner)) out.push(S('hatch', l));
  }
  return { strokes: out, occluders: [outer] };
}

function renderColumn(el: ColumnEl, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  const W = bw(box);
  const H = bh(box);
  const base = Math.min(H * 0.1, 11 * IN);
  const cap = Math.min(H * 0.08, 9 * IN);
  if (el.style === 'tapered') {
    const pedTop = box.y0 + H * 0.36;
    out.push(S('detail', rectLine(box.x0, box.y0, box.x1, pedTop)));
    out.push(S('detail', hline(box.x0, box.x1, box.y0 + base * 0.7)));
    out.push(S('detail', hline(box.x0, box.x1, pedTop - 2 * IN)));
    const topW = W * 0.72;
    const cx = (box.x0 + box.x1) / 2;
    const bot = W * 0.92;
    const shaft = [
      { x: cx - bot / 2, y: pedTop },
      { x: cx + bot / 2, y: pedTop },
      { x: cx + topW / 2, y: box.y1 - cap },
      { x: cx - topW / 2, y: box.y1 - cap },
    ];
    out.push(S('detail', closed(shaft)));
    out.push(S('detail', rectLine(cx - W * 0.44, box.y1 - cap, cx + W * 0.44, box.y1)));
    const poly = [
      { x: box.x0, y: box.y0 },
      { x: box.x1, y: box.y0 },
      { x: box.x1, y: pedTop },
      { x: cx + bot / 2, y: pedTop },
      { x: cx + W * 0.44, y: box.y1 - cap },
      { x: cx + W * 0.44, y: box.y1 },
      { x: cx - W * 0.44, y: box.y1 },
      { x: cx - W * 0.44, y: box.y1 - cap },
      { x: cx - bot / 2, y: pedTop },
      { x: box.x0, y: pedTop },
    ];
    return { strokes: out, occluders: [poly] };
  }
  out.push(S('detail', rectLine(box.x0, box.y0, box.x1, box.y1)));
  out.push(S('detail', hline(box.x0, box.x1, box.y0 + base)));
  out.push(S('detail', hline(box.x0, box.x1, box.y0 + base * 0.55)));
  out.push(S('detail', hline(box.x0, box.x1, box.y1 - cap)));
  out.push(S('detail', hline(box.x0, box.x1, box.y1 - cap * 0.45)));
  const shaftInset = Math.min(1.25 * IN, W * 0.1);
  if (el.style === 'round') {
    for (const f of [0.18, 0.4, 0.75, 0.88]) out.push(S('hatch', vline(box.x0 + W * f, box.y0 + base, box.y1 - cap)));
  } else if (thinFactor(shaftInset, ctx) === 1) {
    out.push(S('hatch', vline(box.x0 + shaftInset, box.y0 + base, box.y1 - cap)));
    out.push(S('hatch', vline(box.x1 - shaftInset, box.y0 + base, box.y1 - cap)));
  }
  return { strokes: out, occluders: [rectPoly(box.x0, box.y0, box.x1, box.y1)] };
}

function renderRailing(r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  const H = bh(box);
  const post = Math.min(5 * IN, bw(box) * 0.1);
  const topRail = { x0: box.x0, y0: box.y1 - Math.min(3.5 * IN, H * 0.14), x1: box.x1, y1: box.y1 };
  const botRail = { x0: box.x0, y0: box.y0 + Math.min(2.5 * IN, H * 0.08), x1: box.x1, y1: box.y0 + Math.min(5 * IN, H * 0.18) };
  const occ: Vec[][] = [];
  for (const b of [topRail, botRail]) {
    out.push(S('detail', rectLine(b.x0, b.y0, b.x1, b.y1)));
    occ.push(rectPoly(b.x0, b.y0, b.x1, b.y1));
  }
  for (const x0 of [box.x0, box.x1 - post]) {
    out.push(S('detail', rectLine(x0, box.y0, x0 + post, box.y1 + 2 * IN)));
    occ.push(rectPoly(x0, box.y0, x0 + post, box.y1 + 2 * IN));
  }
  const pitch = 5.5 * IN * thinFactor(5.5 * IN, ctx);
  const bal = Math.min(1.5 * IN, pitch * 0.3);
  for (let x = box.x0 + post + pitch / 2; x < box.x1 - post - bal; x += pitch) {
    out.push(S('hatch', vline(x, botRail.y1, topRail.y0)));
    if (thinFactor(bal, ctx) === 1) out.push(S('hatch', vline(x + bal, botRail.y1, topRail.y0)));
    occ.push(rectPoly(x, botRail.y1, x + bal, topRail.y0));
  }
  return { strokes: out, occluders: occ };
}

function renderSteps(count: number, r: WRect, ctx: PatternCtx): ElementOutput {
  const out: Stroke[] = [];
  const box: Box = { ...r };
  out.push(S('detail', rectLine(box.x0, box.y0, box.x1, box.y1)));
  const n = count > 0 ? count : Math.max(1, Math.round(bh(box) / (7.25 * IN)));
  const rise = bh(box) / n;
  for (let i = 1; i < n; i++) {
    const y = box.y0 + rise * i;
    out.push(S('detail', hline(box.x0, box.x1, y)));
    if (thinFactor(1 * IN, ctx) === 1) out.push(S('hatch', hline(box.x0, box.x1, y - 1 * IN)));
  }
  return { strokes: out, occluders: [rectPoly(box.x0, box.y0, box.x1, box.y1)] };
}

function renderTrim(r: WRect): ElementOutput {
  const out: Stroke[] = [S('detail', rectLine(r.x0, r.y0, r.x1, r.y1))];
  if (r.x1 - r.x0 > (r.y1 - r.y0) * 3 && r.y1 - r.y0 > 3 * IN) out.push(S('detail', hline(r.x0, r.x1, r.y1 - 0.75 * IN)));
  return { strokes: out, occluders: [rectPoly(r.x0, r.y0, r.x1, r.y1)] };
}

function renderLight(r: WRect): ElementOutput {
  const out: Stroke[] = [];
  const W = r.x1 - r.x0;
  const H = r.y1 - r.y0;
  const cx = (r.x0 + r.x1) / 2;
  const capTop = r.y1;
  const capBot = r.y1 - H * 0.18;
  out.push(S('detail', closed([{ x: r.x0, y: capBot }, { x: r.x1, y: capBot }, { x: cx + W * 0.15, y: capTop }, { x: cx - W * 0.15, y: capTop }])));
  const bodyBot = r.y0 + H * 0.12;
  const body = [
    { x: cx - W * 0.32, y: bodyBot },
    { x: cx + W * 0.32, y: bodyBot },
    { x: cx + W * 0.42, y: capBot },
    { x: cx - W * 0.42, y: capBot },
  ];
  out.push(S('detail', closed(body)));
  out.push(S('hatch', vline(cx, bodyBot, capBot)));
  out.push(S('detail', closed([{ x: cx - W * 0.2, y: r.y0 }, { x: cx + W * 0.2, y: r.y0 }, { x: cx + W * 0.32, y: bodyBot }, { x: cx - W * 0.32, y: bodyBot }])));
  return { strokes: out, occluders: [rectPoly(r.x0, r.y0, r.x1, r.y1)] };
}

// ---------------------------------------------------------------------------
// Walls, roofs, gables, chimneys
// ---------------------------------------------------------------------------

const MASONRY = new Set(['brick', 'stone', 'stucco']);

function renderWall(el: WallEl, poly: Vec[], ctx: RenderCtx): ElementOutput {
  const out: Stroke[] = [S('outline', closed(poly))];
  const area = region(poly);
  const b = area.bbox;
  const exclude: Region[] = [];
  const masonry = MASONRY.has(el.material);
  let anchor = ctx.courseAnchorY;
  if (el.foundation && !masonry && b.y0 < 0.4 && b.y1 > 3) {
    const fh = Math.max(0, b.y0) + 8 * IN;
    for (const l of clipPolyline(hline(b.x0 - 1, b.x1 + 1, fh), [area], [])) out.push(S('detail', l));
    exclude.push(region(rectPoly(b.x0 - 1, b.y0 - 1, b.x1 + 1, fh)));
    anchor = fh;
  }
  if (el.cornerBoards && !masonry && el.material !== 'plain' && b.x1 - b.x0 > 4 && b.y1 - b.y0 > 3) {
    const cb = 4.5 * IN;
    for (const x of [b.x0 + cb, b.x1 - cb]) for (const l of clipPolyline(vline(x, b.y0 - 1, b.y1 + 1), [area], exclude)) out.push(S('detail', l));
    exclude.push(region(rectPoly(b.x0 - 1, b.y0 - 1, b.x0 + cb, b.y1 + 1)));
    exclude.push(region(rectPoly(b.x1 - cb, b.y0 - 1, b.x1 + 1, b.y1 + 1)));
  }
  for (const l of wallPattern(el.material, el.exposureIn, area, exclude, ctx, anchor)) out.push(S('hatch', l));
  return { strokes: out, occluders: [poly] };
}

function isHorizontal(a: Vec, b: Vec) {
  return Math.abs(b.y - a.y) <= Math.abs(b.x - a.x) * Math.tan((7 * Math.PI) / 180);
}

function renderRoof(el: RoofEl, poly: Vec[], ctx: RenderCtx): ElementOutput {
  const out: Stroke[] = [S('outline', closed(poly))];
  const n = poly.length;
  const b = bboxOf(poly);
  const height = b.y1 - b.y0;
  // Counter-clockwise: an edge running +x with the interior above it is an eave.
  const eave = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    return isHorizontal(p, q) && q.x > p.x && q.x - p.x > 0.5;
  });
  let hatchPoly: Vec[] = poly;
  if (el.fascia && eave.some(Boolean)) {
    const f = Math.min(9 * IN, height * 0.3);
    const g = Math.min(5 * IN, height * 0.18);
    for (const d of [g, f]) {
      const inner = insetPolygon(
        poly,
        eave.map((e) => (e ? d : 0)),
      );
      if (!inner) continue;
      inner.forEach((p, i) => {
        if (eave[i]) out.push(S('detail', [p, inner[(i + 1) % n]]));
      });
      if (d === f) hatchPoly = inner;
    }
  }
  const eaveY = hatchPoly.reduce((m, p) => Math.min(m, p.y), Infinity);
  for (const l of roofPattern(el.material, region(hatchPoly), [], ctx, eaveY)) out.push(S('hatch', l));
  return { strokes: out, occluders: [poly] };
}

function renderGable(el: GableEl, poly: Vec[], ctx: RenderCtx): ElementOutput {
  const out: Stroke[] = [S('outline', closed(poly))];
  const n = poly.length;
  const b = bboxOf(poly);
  const H = b.y1 - b.y0;
  const rake = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    // left normal (-dy, dx) points into the polygon; interior below => normal.y < 0
    return !isHorizontal(p, q) && Math.abs(dx) > Math.abs(dy) * 0.15 && dx < 0;
  });
  const bottom = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    return isHorizontal(p, q) && q.x > p.x;
  });
  const r = Math.min((el.rakeIn || 10) * IN, H * 0.25);
  let fill: Vec[] = poly;
  for (const d of [r * 0.3, r]) {
    const inner = insetPolygon(
      poly,
      rake.map((e) => (e ? d : 0)),
    );
    if (!inner) continue;
    inner.forEach((p, i) => {
      if (rake[i]) out.push(S('detail', [p, inner[(i + 1) % n]]));
    });
    if (d === r) fill = inner;
  }
  if (H > 3 && bottom.some(Boolean)) {
    const band = Math.min(7 * IN, H * 0.12);
    const inner = insetPolygon(
      fill,
      bottom.map((e) => (e ? band : 0)),
    );
    if (inner) {
      inner.forEach((p, i) => {
        if (bottom[i]) out.push(S('detail', [p, inner[(i + 1) % n]]));
      });
      fill = inner;
    }
  }
  const area = region(fill);
  for (const l of wallPattern(el.material, el.exposureIn, area, [], ctx, ctx.courseAnchorY)) out.push(S('hatch', l));
  return { strokes: out, occluders: [poly] };
}

function renderChimney(el: ChimneyEl, poly: Vec[], ctx: RenderCtx): ElementOutput {
  const out: Stroke[] = [S('outline', closed(poly))];
  const area = region(poly);
  const b = area.bbox;
  const capA = b.y1 - 4 * IN;
  const capB = b.y1 - 9 * IN;
  const exclude: Region[] = [];
  if (b.y1 - b.y0 > 2) {
    for (const y of [capA, capB]) for (const l of clipPolyline(hline(b.x0 - 1, b.x1 + 1, y), [area], [])) out.push(S('detail', l));
    exclude.push(region(rectPoly(b.x0 - 1, capB, b.x1 + 1, b.y1 + 1)));
  }
  for (const l of wallPattern(el.material, 0, area, exclude, ctx, ctx.courseAnchorY)) out.push(S('hatch', l));
  return { strokes: out, occluders: [poly] };
}

export function renderElement(we: WorldEl, ctx: RenderCtx): ElementOutput {
  const el = we.el;
  const r = we.rect;
  switch (el.kind) {
    case 'wall':
      return renderWall(el, we.poly, ctx);
    case 'roof':
      return renderRoof(el, we.poly, ctx);
    case 'gable':
      return renderGable(el, we.poly, ctx);
    case 'chimney':
      return renderChimney(el, we.poly, ctx);
    case 'window':
      return renderWindow(el, r!, ctx);
    case 'door':
      return renderDoor(el, r!, ctx);
    case 'garage':
      return renderGarage(el, r!, ctx);
    case 'vent':
      return renderVent(el, r!, ctx);
    case 'column':
      return renderColumn(el, r!, ctx);
    case 'railing':
      return renderRailing(r!, ctx);
    case 'steps':
      return renderSteps(el.count, r!, ctx);
    case 'trim':
      return renderTrim(r!);
    case 'light':
      return renderLight(r!);
  }
}
