import { clipPolyline, region } from '../geometry/clip';
import { type Polyline, type Vec, circlePoly, closed, rectPoly, segmentsForRadius } from '../geometry/vec';
import type { FactKey, Level, Project } from '../model/types';
import { type ScaleInfo, type WorldEl, type WorldFrame, autoLevels, resolveScale, toWorldElements, worldBBox } from '../model/world';
import { FONTS, type TextStyle, lineHeight, measureText, textPolylines, wrapText } from '../text/strokeFont';
import { type DrawingScale, customScale, formatFtIn, mmPerFoot, pickStandardScale, scaleById } from '../units';
import { type CalloutSpec, generateCallouts } from './callouts';
import { renderHouse } from './house';
import { optimizeStrokes } from './optimize';
import { type Layer, LAYERS, type Stroke } from './types';

export interface PlacedCallout {
  key: string;
  text: string;
  side: 'left' | 'right';
  enabled: boolean;
  placed: boolean;
  priority: number;
  custom: boolean;
  tag: boolean;
}

export interface SheetStats {
  polylines: number;
  lengthMm: number;
  byLayer: Record<Layer, { polylines: number; lengthMm: number }>;
}

export interface SheetResult {
  widthMm: number;
  heightMm: number;
  strokes: Stroke[];
  scale: DrawingScale | null;
  mmPerFt: number;
  scaleInfo: ScaleInfo;
  frame: WorldFrame;
  toPaper: (w: Vec) => Vec;
  /** Paper mm -> world feet (inverse of toPaper). */
  fromPaper: (p: Vec) => Vec;
  callouts: PlacedCallout[];
  levels: Level[];
  warnings: string[];
  houseWidthFt: number | null;
  houseHeightFt: number | null;
  stats: SheetStats;
}

export const FACT_ORDER: FactKey[] = ['yearBuilt', 'livingArea', 'bedsBaths', 'lotSize', 'stories', 'style', 'parcel', 'subdivision', 'county', 'coordinates', 'elevation', 'footprint'];

class Pen {
  strokes: Stroke[] = [];
  line(layer: Layer, pts: Vec[], w?: number) {
    if (pts.length >= 2) this.strokes.push({ layer, pts, w });
  }
  rect(layer: Layer, x0: number, y0: number, x1: number, y1: number, w?: number) {
    this.line(layer, closed(rectPoly(x0, y0, x1, y1)), w);
  }
  circle(layer: Layer, c: Vec, r: number, w?: number) {
    const pts = circlePoly(c, r, segmentsForRadius(r));
    this.line(layer, [...pts, pts[0]], w);
  }
  text(style: TextStyle, s: string, x: number, y: number, opts: { align?: 'left' | 'center' | 'right'; rotateDeg?: number } = {}, w?: number) {
    const width = w ?? Math.min(0.6, Math.max(0.14, style.size * 0.085));
    for (const pl of textPolylines(style, s, x, y, opts)) this.line('text', pl, width);
  }
  /** A bold line made of parallel passes (reads heavier when laser scored). */
  bold(layer: Layer, a: Vec, b: Vec, passes: number, spacing = 0.16, w?: number) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const n = { x: -dy / l, y: dx / l };
    for (let i = 0; i < passes; i++) {
      const o = (i - (passes - 1) / 2) * spacing;
      this.line(layer, [
        { x: a.x + n.x * o, y: a.y + n.y * o },
        { x: b.x + n.x * o, y: b.y + n.y * o },
      ], w);
    }
  }
  arrow(layer: Layer, from: Vec, tip: Vec, len: number) {
    const dx = tip.x - from.x;
    const dy = tip.y - from.y;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const hw = len * 0.3;
    const base = { x: tip.x - ux * len, y: tip.y - uy * len };
    const p1 = { x: base.x - uy * hw, y: base.y + ux * hw };
    const p2 = { x: base.x + uy * hw, y: base.y - ux * hw };
    this.line(layer, [tip, p1, p2, tip]);
    this.line(layer, [base, tip]);
  }
  tick(layer: Layer, p: Vec, size: number) {
    this.line(layer, [
      { x: p.x - size / 2, y: p.y + size / 2 },
      { x: p.x + size / 2, y: p.y - size / 2 },
    ]);
  }
}

export function effectiveLevels(project: Project, frame: WorldFrame): Level[] {
  return project.levelsCustomized ? project.levels : autoLevels(project, frame);
}

export function factStrings(project: Project): string[] {
  const out: string[] = [];
  for (const k of FACT_ORDER) {
    const v = project.property.facts[k];
    if (v && project.property.show[k]) out.push(v.toUpperCase());
  }
  return out;
}

interface Label {
  spec: CalloutSpec;
  side: 'left' | 'right';
  lines: string[];
  h: number;
  w: number;
  anchor: Vec;
  desired: number;
  top: number;
}

/** Pack labels top-to-bottom near their desired positions without overlapping obstacles. */
function packColumn(labels: Label[], obstacles: [number, number][], top: number, bottom: number, gap: number): boolean {
  labels.sort((a, b) => a.desired - b.desired);
  const obs = [...obstacles].sort((a, b) => a[0] - b[0]);
  const collides = (y: number, h: number) => obs.find(([o0, o1]) => y < o1 + gap && y + h > o0 - gap);
  let cursor = top;
  for (const l of labels) {
    let y = Math.max(l.desired, cursor);
    for (let guard = 0; guard < 50; guard++) {
      const c = collides(y, l.h);
      if (!c) break;
      y = c[1] + gap;
    }
    l.top = y;
    cursor = y + l.h + gap;
  }
  // Pull back up from the bottom if needed.
  cursor = bottom;
  for (let i = labels.length - 1; i >= 0; i--) {
    const l = labels[i];
    if (l.top + l.h > cursor) {
      let y = cursor - l.h;
      for (let guard = 0; guard < 50; guard++) {
        const c = collides(y, l.h);
        if (!c) break;
        y = c[0] - gap - l.h;
      }
      l.top = y;
    }
    cursor = l.top - gap;
  }
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].top < top - 0.01) return false;
    if (i > 0 && labels[i].top < labels[i - 1].top + labels[i - 1].h + gap * 0.5) return false;
  }
  return true;
}

function polylineLength(pts: readonly Vec[]) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

export function computeStats(strokes: readonly Stroke[]): SheetStats {
  const byLayer = Object.fromEntries(LAYERS.map((l) => [l.id, { polylines: 0, lengthMm: 0 }])) as SheetStats['byLayer'];
  let total = 0;
  for (const s of strokes) {
    const l = polylineLength(s.pts);
    byLayer[s.layer].polylines++;
    byLayer[s.layer].lengthMm += l;
    total += l;
  }
  return { polylines: strokes.length, lengthMm: total, byLayer };
}

export function buildSheet(project: Project, opts: { optimize?: boolean } = {}): SheetResult {
  const { layout, annotations: ann } = project;
  const W = layout.paperWidthMm;
  const H = layout.paperHeightMm;
  const m = layout.marginMm;
  const warnings: string[] = [];
  const pen = new Pen();

  const scaleInfo = resolveScale(project);
  const frame: WorldFrame = { pxPerFtX: scaleInfo.pxPerFtX, pxPerFtY: scaleInfo.pxPerFtY, groundY: project.groundY };
  const els: WorldEl[] = toWorldElements(project.elements, frame);
  const bb = worldBBox(els);

  const S = Math.min(3.4, Math.max(1.3, Math.min(W, H) * 0.0105)) * layout.textScale;
  const font = FONTS[layout.font];
  const st = (size: number): TextStyle => ({ font, size });
  const calloutStyle = st(S);
  const levelStyle = st(S * 0.95);
  const dimStyle = st(S * 0.9);
  const titleStyle = st(S * 3);
  const tagStyle = st(S * 0.78);

  const framed = layout.frame !== 'none';
  const content = {
    x0: m + (framed ? 2.5 : 0),
    y0: m + (framed ? 2.5 : 0),
    x1: W - m - (framed ? 2.5 : 0),
    y1: H - m - (framed ? 2.5 : 0),
  };
  const contentW = content.x1 - content.x0;
  const cx = (content.x0 + content.x1) / 2;

  // ----- Title block size -----
  const facts = factStrings(project);
  const factLines = facts.length ? wrapText(st(S * 0.9), facts.join('  ·  '), contentW * 0.86) : [];
  const address = ann.showAddress ? [project.property.line1, project.property.line2].filter(Boolean).join(', ').toUpperCase() : '';
  const T = titleStyle.size;
  const tbHeight =
    1.4 * S + T + 1.4 * S + 2.8 * S + (ann.projectName ? 2.3 * S : 0) + (address ? 1.9 * S : 0) + factLines.length * 1.55 * S;

  // ----- Levels & callouts (world space) -----
  const levels = effectiveLevels(project, frame);
  const shownLevels = ann.showLevels ? levels.filter((l) => l.show && l.heightFt > 0.05).sort((a, b) => a.heightFt - b.heightFt) : [];
  const houseX0 = bb ? bb.x0 : 0;
  const houseX1 = bb ? bb.x1 : 1;
  const fixedScale = layout.scaleId !== 'auto' && layout.scaleId !== 'fit' ? scaleById(layout.scaleId) : null;
  const metric = layout.scaleSystem === 'metric' ? !fixedScale || fixedScale.system === 'metric' : fixedScale?.system === 'metric';
  const fmtLen = (ft: number) => (metric ? `${(ft * 0.3048).toFixed(2)} M` : formatFtIn(ft, ann.dimPrecision));
  const specs = bb ? generateCallouts({ project, frame, els, houseX0, houseX1, metric }) : [];
  const activeSpecs = ann.showCallouts ? specs.filter((s) => s.enabled && (s.text || s.tag)) : [];

  const gap = 2.2 * S;
  const dimStripW = shownLevels.length && ann.showDimensions ? 3.2 * S : 0;
  const topPad = ann.showPitch ? 3.6 * S : 1.6 * S;
  const belowGrade = ann.showDimensions ? 4.6 * S : 1.6 * S;
  const houseW = bb ? Math.max(1, bb.x1 - bb.x0) : 40;
  const houseTop = bb ? Math.max(bb.y1, 1) : 25;
  const zoneY0 = content.y0 + topPad;
  const zoneY1 = content.y1 - tbHeight - belowGrade;

  // Small boards get fewer callouts so the drawing is not buried in text.
  const budget = Math.max(4, Math.min(ann.maxCallouts, Math.round(Math.sqrt(W * H) / 14)));
  const chosenSpecs = [...activeSpecs].sort((a, b) => b.priority - a.priority).slice(0, budget);
  const lhC = lineHeight(calloutStyle);
  const vgap = 0.9 * S;
  const tagR = 1.9 * S;
  const columnNeed = (cw: number) => {
    let total = 0;
    for (const sp of chosenSpecs) total += (sp.tag ? tagR * 2 : (wrapText(calloutStyle, sp.text.toUpperCase(), cw).length - 1) * lhC + S) + vgap;
    return total / 2 + shownLevels.length * (levelStyle.size + 2.2) * 0.5;
  };
  const scaleFor = (kMax: number): DrawingScale => {
    if (layout.scaleId === 'auto') return pickStandardScale(kMax, layout.scaleSystem) ?? customScale(kMax);
    if (layout.scaleId === 'fit') return customScale(kMax);
    return scaleById(layout.scaleId) ?? pickStandardScale(kMax, layout.scaleSystem) ?? customScale(kMax);
  };
  const zoneFor = (cw: number) => {
    const x0 = content.x0 + (cw ? cw + gap : gap * 0.5);
    const x1 = content.x1 - (cw ? cw + gap : gap * 0.5) - (dimStripW ? dimStripW + gap * 0.5 : 0);
    return { x0, x1, kMax: Math.max(0.01, Math.min((x1 - x0) / houseW, (zoneY1 - zoneY0) / houseTop)) };
  };
  // Pick the callout column width that allows the largest drawing while the labels still fit.
  let colW = 0;
  if (chosenSpecs.length) {
    const colAvail = content.y1 - tbHeight - content.y0;
    const widths = [20, 16.5, 13.5, 11].map((f) => f * S).filter((w) => w <= Math.max(12 * S, contentW * 0.2));
    if (!widths.length) widths.push(11 * S);
    let best: { cw: number; k: number } | null = null;
    for (const cw of widths) {
      if (columnNeed(cw) > colAvail * 0.92 && cw !== widths[0]) continue;
      const k = mmPerFoot(scaleFor(zoneFor(cw).kMax));
      if (!best || k > best.k * 1.0001) best = { cw, k };
    }
    colW = best?.cw ?? widths[0];
  }
  const { x0: zoneX0, x1: zoneX1, kMax } = zoneFor(colW);
  const scale = scaleFor(kMax);
  if (layout.scaleId !== 'auto' && layout.scaleId !== 'fit' && mmPerFoot(scale) > kMax * 1.001) {
    warnings.push(`At ${scale.label} the house is larger than the space on this sheet — pick a smaller scale or a larger board.`);
  }
  const k = mmPerFoot(scale);
  const houseWmm = houseW * k;
  const houseHmm = houseTop * k;
  // Columns grow into any space the standard scale leaves over.
  const colWEff = colW ? Math.min(26 * S, colW + Math.max(0, (zoneX1 - zoneX0 - houseWmm) / 2)) : 0;
  // Centre the whole composition — house, label columns and title block — vertically.
  const contentH = content.y1 - content.y0;
  const need = colWEff ? columnNeed(colWEff) - belowGrade * 0.8 : 0;
  const above = Math.max(topPad + houseHmm, Math.min(need, contentH - belowGrade - tbHeight));
  const total = above + belowGrade + tbHeight;
  const startY = content.y0 + Math.max(0, (contentH - total) / 2);
  const gradeY = startY + above;
  const hx0 = (zoneX0 + zoneX1) / 2 - houseWmm / 2;
  const bx0 = bb ? bb.x0 : 0;
  const toPaper = (w: Vec): Vec => ({ x: hx0 + (w.x - bx0) * k, y: gradeY - w.y * k });
  const fromPaper = (p: Vec): Vec => ({ x: (p.x - hx0) / k + bx0, y: (gradeY - p.y) / k });
  const houseLeft = hx0;
  const houseRight = hx0 + houseWmm;
  const knockouts: Vec[][] = [];

  // ----- Ground line & overall width -----
  const ext = Math.min(gap * 0.9, 9);
  if (bb) {
    pen.bold('outline', { x: houseLeft - ext, y: gradeY }, { x: houseRight + ext, y: gradeY }, 3, 0.17);
  }
  let wallX0 = houseX0;
  let wallX1 = houseX1;
  // Overall width is wall to wall (gables and roofs include overhangs).
  const walls = els.filter((e) => e.el.kind === 'wall');
  const wallEls = walls.length ? walls : els.filter((e) => e.el.kind === 'gable');
  if (wallEls.length) {
    wallX0 = Math.min(...wallEls.map((e) => Math.min(...e.poly.map((p) => p.x))));
    wallX1 = Math.max(...wallEls.map((e) => Math.max(...e.poly.map((p) => p.x))));
  }
  const houseWidthFt = bb ? wallX1 - wallX0 : null;
  if (bb && ann.showDimensions && houseWidthFt) {
    const px0 = toPaper({ x: wallX0, y: 0 }).x;
    const px1 = toPaper({ x: wallX1, y: 0 }).x;
    const dimY = gradeY + 2.9 * S;
    for (const x of [px0, px1]) pen.line('annotation', [{ x, y: gradeY + 0.9 }, { x, y: dimY + 1.2 }]);
    pen.line('annotation', [{ x: px0 - 1.2, y: dimY }, { x: px1 + 1.2, y: dimY }]);
    pen.tick('annotation', { x: px0, y: dimY }, S * 0.9);
    pen.tick('annotation', { x: px1, y: dimY }, S * 0.9);
    pen.text(dimStyle, fmtLen(houseWidthFt), (px0 + px1) / 2, dimY - 0.7, { align: 'center' });
  }

  // ----- Levels -----
  const colLeftX = houseRight + gap; // right column text starts here
  const rightColEnd = colLeftX + colWEff;
  const dimX = (colWEff ? rightColEnd : houseRight + gap) + gap * 0.5 + dimStripW * 0.6;
  const rightObstacles: [number, number][] = [];
  if (bb && shownLevels.length) {
    const lineEnd = dimStripW ? dimX : colWEff ? rightColEnd : houseRight + gap * 2;
    const heights = [0, ...shownLevels.map((l) => l.heightFt)];
    for (const l of shownLevels) {
      const y = gradeY - l.heightFt * k;
      if (y < content.y0) continue;
      pen.line('annotation', [{ x: houseRight + 1.2, y }, { x: lineEnd + (dimStripW ? 1.2 : 0), y }]);
      const lx = colWEff ? colLeftX : houseRight + 2;
      pen.text(levelStyle, l.name.toUpperCase(), lx, y - 0.9, { align: 'left' });
      rightObstacles.push([y - 0.9 - levelStyle.size - 0.5, y + 0.6]);
    }
    if (dimStripW) {
      const ys = heights.map((h) => gradeY - h * k);
      pen.line('annotation', [{ x: dimX, y: Math.min(...ys) - 1.2 }, { x: dimX, y: gradeY + 1.2 }]);
      pen.line('annotation', [{ x: houseRight + ext + 0.5, y: gradeY }, { x: dimX + 1.2, y: gradeY }]);
      for (const y of ys) pen.tick('annotation', { x: dimX, y }, S * 0.9);
      for (let i = 1; i < heights.length; i++) {
        const y0 = ys[i - 1];
        const y1 = ys[i];
        const txt = fmtLen(heights[i] - heights[i - 1]);
        const tw = measureText(dimStyle, txt);
        if (Math.abs(y0 - y1) > tw + 1.2) pen.text(dimStyle, txt, dimX - 0.7, (y0 + y1) / 2, { align: 'center', rotateDeg: 90 });
        else pen.text(dimStyle, txt, dimX + 1.2, (y0 + y1) / 2 + dimStyle.size / 2, { align: 'left' });
      }
    }
  }

  // ----- Pitch symbols -----
  if (bb && ann.showPitch) {
    const cands: { a: Vec; b: Vec; pitch: number; len: number }[] = [];
    for (const e of els) {
      if (e.el.kind !== 'gable' && e.el.kind !== 'roof') continue;
      const n = e.poly.length;
      for (let i = 0; i < n; i++) {
        const a = e.poly[i];
        const b = e.poly[(i + 1) % n];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx >= 0 || Math.abs(dx) < 2) continue; // top edges run leftward in CCW order
        const pitch = Math.round((Math.abs(dy) / Math.abs(dx)) * 12);
        if (pitch < 2 || pitch > 24) continue;
        cands.push({ a, b, pitch, len: Math.hypot(dx, dy) });
      }
    }
    cands.sort((p, q) => q.len - p.len);
    const seen = new Set<number>();
    const placed: Vec[] = [];
    for (const c of cands) {
      if (placed.length >= 2) break;
      if (seen.has(c.pitch)) continue;
      const pa = toPaper(c.a);
      const pb = toPaper(c.b);
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      if (placed.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < 14 * S)) continue;
      seen.add(c.pitch);
      placed.push(mid);
      // Outward normal (paper, y down) pointing up/away from the roof.
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const l = Math.hypot(dx, dy);
      let nx = dy / l;
      let ny = -dx / l;
      if (ny > 0) {
        nx = -nx;
        ny = -ny;
      }
      const L = 3.2 * S;
      const rise = (L * c.pitch) / 12;
      const origin = { x: mid.x + nx * 2.4 * S, y: mid.y + ny * 2.4 * S };
      const slopeUpRight = (pb.y - pa.y) / (pb.x - pa.x) < 0;
      const x0 = origin.x - L / 2;
      const x1 = origin.x + L / 2;
      const yb = origin.y;
      const vx = slopeUpRight ? x1 : x0;
      const hx = slopeUpRight ? x0 : x1;
      pen.line('annotation', [{ x: hx, y: yb }, { x: vx, y: yb }, { x: vx, y: yb - rise }, { x: hx, y: yb }]);
      pen.text(tagStyle, '12', origin.x, yb + tagStyle.size + 0.5, { align: 'center' });
      const pitchTxt = String(c.pitch);
      const tx = slopeUpRight ? vx + 0.7 : vx - 0.7;
      pen.text(tagStyle, pitchTxt, tx, yb - rise / 2 + tagStyle.size / 2, { align: slopeUpRight ? 'left' : 'right' });
      const tw = measureText(tagStyle, pitchTxt);
      const kx0 = Math.min(x0, slopeUpRight ? x0 : tx - tw) - 0.8;
      const kx1 = Math.max(x1, slopeUpRight ? tx + tw : x1) + 0.8;
      knockouts.push(rectPoly(kx0, yb - rise - 0.8, kx1, yb + tagStyle.size + 1.3));
    }
  }

  // ----- House linework (with knockouts behind symbols placed over it) -----
  if (bb) {
    const world = renderHouse(els, {
      mmPerFt: k,
      minHatchMm: layout.minHatchMm,
      detail: layout.detail,
      courseAnchorY: 8 / 12,
    });
    const ko = knockouts.map((p) => region(p));
    for (const s of world) {
      const pts = s.pts.map(toPaper);
      if (!ko.length) pen.line(s.layer, pts);
      else for (const piece of clipPolyline(pts, null, ko)) pen.line(s.layer, piece);
    }
  } else {
    pen.text(st(S * 1.4), 'TRACE THE HOUSE TO GENERATE THE ELEVATION', cx, (content.y0 + content.y1) / 2 - 10, { align: 'center' });
  }

  // ----- Callouts -----
  const placedCallouts: PlacedCallout[] = specs.map((s) => ({
    key: s.key,
    text: s.text,
    side: 'right',
    enabled: s.enabled,
    placed: false,
    priority: s.priority,
    custom: !!s.custom,
    tag: !!s.tag,
  }));
  if (bb && colWEff && activeSpecs.length) {
    const colTop = content.y0 + 0.3 * S;
    const colBottom = gradeY + belowGrade * 0.8;
    const lh = lhC;
    const makeLabel = (spec: CalloutSpec, side: 'left' | 'right'): Label => {
      let world = spec.anchor;
      if (spec.candidates?.length) {
        world = spec.candidates.reduce((best, c) => (side === 'left' ? (c.x < best.x ? c : best) : c.x > best.x ? c : best), spec.candidates[0]);
      }
      const anchor = toPaper(world);
      if (spec.tag) {
        return { spec, side, lines: [], h: tagR * 2, w: tagR * 2, anchor, desired: anchor.y - tagR, top: 0 };
      }
      const lines = wrapText(calloutStyle, spec.text.toUpperCase(), colWEff);
      const h = (lines.length - 1) * lh + calloutStyle.size;
      const w = Math.max(...lines.map((t) => measureText(calloutStyle, t)));
      return { spec, side, lines, h, w, anchor, desired: anchor.y - calloutStyle.size / 2, top: 0 };
    };
    const chosen = chosenSpecs;
    // Balance the two columns: split automatic callouts left/right by anchor x.
    const sideOf = new Map<CalloutSpec, 'left' | 'right'>();
    const fixedLeft = chosen.filter((s) => s.side === 'left');
    const fixedRight = chosen.filter((s) => s.side === 'right');
    for (const s of fixedLeft) sideOf.set(s, 'left');
    for (const s of fixedRight) sideOf.set(s, 'right');
    // Flexible callouts (several equivalent anchors) sort to the middle so fixed ones keep their natural side.
    const houseMidX = (houseX0 + houseX1) / 2;
    const sortX = (s: CalloutSpec) => (s.candidates && s.candidates.length > 1 ? houseMidX : s.anchor.x);
    const autos = chosen.filter((s) => s.side === 'auto').sort((a, b) => sortX(a) - sortX(b));
    const leftTarget = Math.max(0, Math.min(autos.length, Math.round((chosen.length + rightObstacles.length * 0.5) / 2) - fixedLeft.length));
    autos.forEach((s, i) => sideOf.set(s, i < leftTarget ? 'left' : 'right'));

    const cols: Record<'left' | 'right', Label[]> = { left: [], right: [] };
    const obstaclesFor = (side: 'left' | 'right') => (side === 'right' ? rightObstacles : []);
    for (const spec of chosen) {
      const preferred = sideOf.get(spec) ?? 'right';
      const tryOrder: ('left' | 'right')[] = spec.side === 'auto' ? [preferred, preferred === 'left' ? 'right' : 'left'] : [preferred];
      for (const side of tryOrder) {
        const trial = [...cols[side], makeLabel(spec, side)];
        if (packColumn(trial, obstaclesFor(side), colTop, colBottom, vgap)) {
          cols[side] = trial;
          break;
        }
      }
    }
    for (const side of ['left', 'right'] as const) {
      const labels = cols[side];
      packColumn(labels, obstaclesFor(side), colTop, colBottom, vgap);
      for (const l of labels) {
        const pc = placedCallouts.find((p) => p.key === l.spec.key);
        if (pc) {
          pc.placed = true;
          pc.side = side;
        }
        const textRight = houseLeft - gap;
        const textLeft = colLeftX;
        let attach: Vec;
        if (l.spec.tag) {
          const c = { x: side === 'left' ? textRight - tagR : textLeft + tagR, y: l.top + tagR };
          pen.circle('annotation', c, tagR);
          pen.line('annotation', [{ x: c.x - tagR, y: c.y }, { x: c.x + tagR, y: c.y }]);
          pen.text(tagStyle, l.spec.tag.top, c.x, c.y - tagR * 0.28, { align: 'center' });
          pen.text(tagStyle, l.spec.tag.bottom, c.x, c.y + tagR * 0.28 + tagStyle.size, { align: 'center' });
          attach = { x: side === 'left' ? c.x + tagR : c.x - tagR, y: c.y };
        } else {
          l.lines.forEach((t, i) => {
            const ty = l.top + calloutStyle.size + i * lh;
            pen.text(calloutStyle, t, side === 'left' ? textRight : textLeft, ty, { align: side === 'left' ? 'right' : 'left' });
          });
          const yMid = l.top + calloutStyle.size / 2;
          attach = { x: side === 'left' ? textRight + 0.9 : textLeft - 0.9, y: yMid };
        }
        const shoulder = { x: attach.x + (side === 'left' ? 1.6 : -1.6), y: attach.y };
        const tip = l.anchor;
        pen.line('annotation', [attach, shoulder, tip]);
        pen.arrow('annotation', shoulder, tip, Math.max(1.1, S * 0.62));
      }
    }
  }

  // ----- Title block (directly under the drawing) -----
  let y = (bb ? gradeY + belowGrade : content.y1 - tbHeight) + 1.4 * S;
  const titleText = `${ann.title.toUpperCase()}${ann.elevationTag ? ` "${ann.elevationTag.toUpperCase()}"` : ''}`;
  const titleW = measureText(titleStyle, titleText);
  const tBase = y + T;
  pen.text(titleStyle, titleText, cx, tBase, { align: 'center' }, Math.min(0.6, T * 0.075));
  const ux0 = cx - titleW / 2 - S * 0.8;
  const ux1 = cx + titleW / 2 + S * 0.8;
  const u1 = tBase + 0.75 * S;
  const u2 = u1 + 0.55 * S;
  pen.bold('outline', { x: ux0, y: u1 }, { x: ux1, y: u1 }, 3, 0.16);
  pen.line('annotation', [{ x: ux0, y: u2 }, { x: ux1, y: u2 }]);
  // Title bubble
  const R = T * 0.62;
  const bc = { x: ux1 + R + S * 1.2, y: tBase - T / 2 + 0.2 * S };
  if (bc.x + R < content.x1) {
    pen.circle('annotation', bc, R);
    pen.line('annotation', [{ x: bc.x - R, y: bc.y }, { x: bc.x + R, y: bc.y }]);
    pen.text(st(S * 0.95), '1', bc.x, bc.y - R * 0.25, { align: 'center' });
    pen.text(st(S * 0.8), ann.sheetName.toUpperCase(), bc.x, bc.y + R * 0.25 + S * 0.8, { align: 'center' });
  }
  const scaleLabel = scale.system === 'imperial' || scale.id.startsWith('custom') ? `SCALE: ${scale.label}` : `SCALE ${scale.label}`;
  const scaleStyle = st(S * 1.0);
  const rowTop = u2 + 0.9 * S;
  const scaleBase = rowTop + scaleStyle.size;
  pen.text(scaleStyle, scaleLabel, ux1, scaleBase, { align: 'right' });

  // Graphic scale bar (left end of the same row).
  if (ann.showScaleBar) {
    const metric = scale.system === 'metric' && !scale.id.startsWith('custom');
    const unitFt = [1, 2, 4, 5, 8, 10, 16, 20, 40].find((u) => u * 4 * k >= 13 * S) ?? 40;
    const unit = metric ? ([0.5, 1, 2, 5, 10, 20].find((u) => (u / 0.3048) * 4 * k >= 13 * S) ?? 20) / 0.3048 : unitFt;
    const segs = [0, unit, unit * 2, unit * 4];
    const barLen = unit * 4 * k;
    const barH = 0.6 * S;
    const scaleTextW = measureText(scaleStyle, scaleLabel);
    let bx = ux0;
    if (bx + barLen + 3 * S > ux1 - scaleTextW) bx = Math.max(content.x0 + S, ux0 - barLen - 4 * S);
    const by = rowTop;
    pen.rect('annotation', bx, by, bx + barLen, by + barH);
    for (let i = 0; i < segs.length - 1; i++) {
      const x0 = bx + segs[i] * k;
      const x1 = bx + segs[i + 1] * k;
      pen.line('annotation', [{ x: x0, y: by }, { x: x0, y: by + barH }]);
      if (i % 2 === 0) for (let j = 1; j < 3; j++) pen.line('annotation', [{ x: x0, y: by + (barH * j) / 3 }, { x: x1, y: by + (barH * j) / 3 }]);
    }
    const lab = st(S * 0.7);
    segs.forEach((sv) => {
      const txt = metric ? `${Math.round(sv * 0.3048 * 10) / 10}` : `${Math.round(sv)}`;
      pen.text(lab, txt, bx + sv * k, by + barH + 0.6 + lab.size, { align: 'center' });
    });
    pen.text(lab, metric ? 'M' : 'FT', bx + barLen + 1.4, by + barH, { align: 'left' });
  }
  y = rowTop + 1.9 * S;
  if (ann.projectName) {
    y += 1.35 * S + 0.3 * S;
    pen.text(st(S * 1.35), ann.projectName.toUpperCase(), cx, y, { align: 'center' });
    y += 0.65 * S;
  }
  if (address) {
    y += 1.05 * S + 0.55 * S;
    pen.text(st(S * 1.05), address, cx, y, { align: 'center' });
    y += 0.3 * S;
  }
  for (const fl of factLines) {
    y += 0.9 * S + 0.65 * S;
    pen.text(st(S * 0.9), fl, cx, y, { align: 'center' });
  }

  // ----- Centre everything drawn so far vertically on the sheet -----
  let shiftY = 0;
  if (bb) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const st of pen.strokes) for (const q of st.pts) {
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    const free = content.y1 - content.y0 - (maxY - minY);
    if (isFinite(minY) && free > 0) {
      shiftY = content.y0 + free / 2 - minY;
      if (Math.abs(shiftY) > 0.01) for (const st of pen.strokes) st.pts = st.pts.map((q) => ({ x: q.x, y: q.y + shiftY }));
    }
  }
  const finalToPaper = (w: Vec): Vec => {
    const q = toPaper(w);
    return { x: q.x, y: q.y + shiftY };
  };
  const finalFromPaper = (p: Vec): Vec => fromPaper({ x: p.x, y: p.y - shiftY });

  // ----- Frame & cut line -----
  if (layout.frame !== 'none') {
    pen.rect('outline', m, m, W - m, H - m);
    if (layout.frame === 'double') pen.rect('annotation', m + 1, m + 1, W - m - 1, H - m - 1);
  }
  if (layout.cutOutline !== 'none') {
    if (layout.cutOutline === 'rect') pen.rect('cut', 0, 0, W, H);
    else pen.line('cut', roundedRect(0, 0, W, H, Math.min(layout.cornerRadiusMm, W / 2, H / 2)));
  }

  // Keep everything on the sheet.
  const sheet = region(rectPoly(0, 0, W, H));
  let strokes: Stroke[] = [];
  for (const s of pen.strokes) {
    if (s.layer === 'cut') {
      strokes.push(s);
      continue;
    }
    const inside = s.pts.every((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H);
    if (inside) strokes.push(s);
    else for (const pts of clipPolyline(s.pts, [sheet], [])) strokes.push({ ...s, pts });
  }
  if (bb && (houseLeft < 0 || houseRight > W || gradeY + shiftY - houseHmm < 0 || gradeY + shiftY > H)) warnings.push('Part of the drawing falls outside the sheet.');
  if (opts.optimize !== false) strokes = optimizeStrokes(strokes);
  if (scaleInfo.confidence === 'guess' && bb) warnings.push('Scale is a rough guess. Add a door or garage door, or measure a known length in the Scale panel.');

  return {
    widthMm: W,
    heightMm: H,
    strokes,
    scale,
    mmPerFt: k,
    scaleInfo,
    frame,
    toPaper: finalToPaper,
    fromPaper: finalFromPaper,
    callouts: placedCallouts,
    levels,
    warnings,
    houseWidthFt,
    houseHeightFt: bb ? houseTop : null,
    stats: computeStats(strokes),
  };
}

export function roundedRect(x0: number, y0: number, x1: number, y1: number, r: number): Polyline {
  if (r <= 0) return closed(rectPoly(x0, y0, x1, y1));
  const n = Math.max(6, Math.ceil(segmentsForRadius(r) / 4));
  const arc = (cx: number, cy: number, a0: number): Vec[] => {
    const pts: Vec[] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((Math.PI / 2) * i) / n;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
  };
  const pts = [
    ...arc(x1 - r, y1 - r, 0),
    ...arc(x0 + r, y1 - r, Math.PI / 2),
    ...arc(x0 + r, y0 + r, Math.PI),
    ...arc(x1 - r, y0 + r, (3 * Math.PI) / 2),
  ];
  return [...pts, pts[0]];
}

