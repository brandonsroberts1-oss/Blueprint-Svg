import { type Region, region } from '../geometry/clip';
import { area as polyArea, pointInPolygon, pointSegmentDistance } from '../geometry/polygon';
import { type Vec, bboxOf } from '../geometry/vec';
import type { DoorEl, GarageEl, HouseElement, Project, RoofMaterial, WallMaterial, WindowEl, WindowStyle } from '../model/types';
import { type WorldEl, type WorldFrame, pxToWorld } from '../model/world';
import { formatFtIn } from '../units';
import { IN } from './patterns';

export interface CalloutSpec {
  key: string;
  text: string;
  /** Anchor in world feet. */
  anchor: Vec;
  /**
   * Equivalent anchors (other instances of a "TYP." item, or the same surface seen
   * from the other side). The layout uses the one closest to the label's column.
   */
  candidates?: Vec[];
  side: 'left' | 'right' | 'auto';
  priority: number;
  enabled: boolean;
  /** Detail-tag bubble instead of text. */
  tag?: { top: string; bottom: string };
  custom?: boolean;
}

const ROOF_TEXT: Record<RoofMaterial, string> = {
  shingle: 'ARCHITECTURAL ASPHALT SHINGLES',
  metal: 'STANDING SEAM METAL ROOF',
  tile: 'CLAY TILE ROOF',
  slate: 'SLATE ROOF',
  shake: 'CEDAR SHAKE ROOF',
  flat: 'LOW-SLOPE MEMBRANE ROOF',
};

const WALL_TEXT: Record<WallMaterial, string> = {
  lap: 'HORIZONTAL LAP SIDING',
  'dutch-lap': 'DUTCH LAP SIDING',
  'board-batten': 'BOARD & BATTEN SIDING',
  vertical: 'VERTICAL SIDING',
  shake: 'SHAKE SIDING',
  brick: 'BRICK VENEER',
  stone: 'STONE VENEER',
  stucco: 'STUCCO FINISH',
  plain: 'SIDING',
};

const WINDOW_TEXT: Record<WindowStyle, string> = {
  'double-hung': 'DOUBLE-HUNG WINDOW',
  casement: 'CASEMENT WINDOW',
  picture: 'FIXED PICTURE WINDOW',
  slider: 'SLIDING WINDOW',
  awning: 'AWNING WINDOW',
  'arch-top': 'ARCH-TOP WINDOW',
  'half-round': 'HALF-ROUND WINDOW',
  round: 'ROUND WINDOW',
  octagon: 'OCTAGON WINDOW',
};

const DOOR_TEXT: Record<DoorEl['style'], string> = {
  'six-panel': 'SIX-PANEL ENTRY DOOR',
  craftsman: 'CRAFTSMAN ENTRY DOOR',
  'half-lite': 'HALF-LITE ENTRY DOOR',
  'full-lite': 'FULL-LITE ENTRY DOOR',
  flush: 'ENTRY DOOR',
  double: 'DOUBLE ENTRY DOORS',
  french: 'FRENCH DOORS',
};

/** Round a nominal size to the nearest 2 inches (door/window sizes come in 2" steps). */
const nominal = (ft: number) => Math.max(1 / 6, Math.round(ft * 6) / 6);

function roofArea(e: WorldEl) {
  return polyArea(e.poly);
}

/**
 * Pick a visible point inside `poly` (not hidden by `front`), as far from edges as reasonable
 * and biased toward `towardX`.
 */
export function visibleAnchor(poly: Vec[], front: readonly Region[], towardX: number, avoid: readonly Vec[] = []): Vec | null {
  const b = bboxOf(poly);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  if (w <= 0 || h <= 0) return null;
  const cands: { p: Vec; clear: number }[] = [];
  const NX = 14;
  const NY = 10;
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY; j++) {
      const p = { x: b.x0 + (w * (i + 0.5)) / NX, y: b.y0 + (h * (j + 0.5)) / NY };
      if (p.y < 0.2 || !pointInPolygon(p, poly)) continue;
      if (front.some((r) => p.x >= r.bbox.x0 && p.x <= r.bbox.x1 && p.y >= r.bbox.y0 && p.y <= r.bbox.y1 && pointInPolygon(p, r.poly))) continue;
      let clear = Infinity;
      for (let k = 0; k < poly.length; k++) clear = Math.min(clear, pointSegmentDistance(p, poly[k], poly[(k + 1) % poly.length]));
      for (const r of front) {
        if (p.x < r.bbox.x0 - clear || p.x > r.bbox.x1 + clear || p.y < r.bbox.y0 - clear || p.y > r.bbox.y1 + clear) continue;
        for (let k = 0; k < r.poly.length; k++) clear = Math.min(clear, pointSegmentDistance(p, r.poly[k], r.poly[(k + 1) % r.poly.length]));
      }
      for (const a of avoid) clear = Math.min(clear, Math.hypot(a.x - p.x, a.y - p.y) * 0.8);
      cands.push({ p, clear });
    }
  }
  if (!cands.length) return null;
  const best = Math.max(...cands.map((c) => c.clear));
  const good = cands.filter((c) => c.clear >= best * 0.45);
  good.sort((a, b) => Math.abs(a.p.x - towardX) - Math.abs(b.p.x - towardX) || b.clear - a.clear);
  return good[0].p;
}

export interface CalloutContext {
  project: Project;
  frame: WorldFrame;
  els: WorldEl[];
  houseX0: number;
  houseX1: number;
  /** Write sizes in metres/millimetres instead of feet-inches. */
  metric?: boolean;
}

export function generateCallouts(ctx: CalloutContext): CalloutSpec[] {
  const { els, project } = ctx;
  const specs: CalloutSpec[] = [];
  const midX = (ctx.houseX0 + ctx.houseX1) / 2;
  const used: Vec[] = [];
  const regions = els.map((e) => region(e.poly));
  const frontOf = (i: number) => regions.slice(i + 1);
  const idx = (e: WorldEl) => els.indexOf(e);
  const sideX = (x: number) => (x < midX ? ctx.houseX0 : ctx.houseX1);
  const size2 = (wFt: number, hFt: number) =>
    ctx.metric ? `${(wFt * 0.3048).toFixed(2)} x ${(hFt * 0.3048).toFixed(2)} M` : `${formatFtIn(nominal(wFt))} x ${formatFtIn(nominal(hFt))}`;
  const push = (s: Omit<CalloutSpec, 'enabled' | 'side'> & { side?: CalloutSpec['side'] }) => {
    specs.push({ side: 'auto', enabled: true, ...s });
    used.push(s.anchor);
  };
  const anchorIn = (e: WorldEl, toward?: number) => {
    const b = bboxOf(e.poly);
    const cx = (b.x0 + b.x1) / 2;
    return visibleAnchor(e.poly, frontOf(idx(e)), toward ?? sideX(cx), used);
  };
  /** Left- and right-leaning visible anchors on a surface. */
  const bothSides = (e: WorldEl): Vec[] => {
    const a = visibleAnchor(e.poly, frontOf(idx(e)), ctx.houseX0 - 100, used);
    const b = visibleAnchor(e.poly, frontOf(idx(e)), ctx.houseX1 + 100, used);
    return [a, b].filter((p): p is Vec => !!p);
  };

  // Roofs by material.
  const roofs = els.filter((e) => e.el.kind === 'roof');
  const roofMaterials = [...new Set(roofs.map((e) => (e.el as { material: RoofMaterial }).material))];
  for (const m of roofMaterials) {
    const group = roofs.filter((e) => (e.el as { material: RoofMaterial }).material === m).sort((a, b) => roofArea(b) - roofArea(a));
    const a = anchorIn(group[0]);
    if (a) push({ key: `roof:${m}`, text: ROOF_TEXT[m], anchor: a, candidates: group.flatMap(bothSides), priority: 9 });
  }
  const eaveRoof = [...roofs].sort((a, b) => roofArea(b) - roofArea(a)).find((e) => (e.el as { fascia: boolean }).fascia);
  if (eaveRoof) {
    const b = bboxOf(eaveRoof.poly);
    const eaveY = b.y0;
    const bottomPts = eaveRoof.poly.filter((p) => Math.abs(p.y - eaveY) < 0.05);
    if (bottomPts.length >= 2) {
      const xs = bottomPts.map((p) => p.x);
      const x = midX < (b.x0 + b.x1) / 2 ? Math.max(...xs) - 1.2 : Math.min(...xs) + 1.2;
      push({ key: 'roof:gutter', text: 'ALUMINUM GUTTER ON FASCIA (TYP.)', anchor: { x, y: eaveY + 3 * IN }, priority: 5 });
    }
  }

  // Gables.
  const gables = els.filter((e) => e.el.kind === 'gable').sort((a, b) => roofArea(b) - roofArea(a));
  if (gables.length) {
    const g = gables[0];
    const b = bboxOf(g.poly);
    // a point on the rake band: 30% down from the apex along the left or right slope
    const apex = g.poly.reduce((m, p) => (p.y > m.y ? p : m), g.poly[0]);
    const toward = sideX((b.x0 + b.x1) / 2);
    const foot = toward < apex.x ? { x: b.x0, y: b.y0 } : { x: b.x1, y: b.y0 };
    const t = 0.45;
    const onRake = { x: apex.x + (foot.x - apex.x) * t, y: apex.y + (foot.y - apex.y) * t };
    const band = Math.min(((g.el as { rakeIn: number }).rakeIn || 10) * IN, (b.y1 - b.y0) * 0.25) * 0.55;
    push({ key: 'gable:rake', text: 'RAKE TRIM (TYP.)', anchor: { x: onRake.x, y: onRake.y - band }, priority: 6 });
  }

  // Walls by material (and gable infill if it differs).
  const walls = els.filter((e) => e.el.kind === 'wall' || e.el.kind === 'gable');
  const wallMaterials = [...new Set(walls.map((e) => (e.el as { material: WallMaterial }).material))];
  for (const m of wallMaterials) {
    if (m === 'plain') continue;
    const group = walls.filter((e) => (e.el as { material: WallMaterial }).material === m).sort((a, b) => roofArea(b) - roofArea(a));
    const target = group.find((e) => e.el.kind === 'wall') ?? group[0];
    const a = anchorIn(target);
    if (!a) continue;
    let text = WALL_TEXT[m];
    const tb = bboxOf(target.poly);
    if ((m === 'stone' || m === 'brick') && tb.y1 < 5 && target.el.kind === 'wall') text = `${text} WAINSCOT W/ CAP`;
    if (target.el.kind === 'gable') text = `${text} @ GABLE`;
    const same = group.filter((e) => e.el.kind === target.el.kind);
    push({ key: `wall:${m}`, text, anchor: a, candidates: same.flatMap(bothSides), priority: 8 });
  }
  const cornerWall = els.find((e) => e.el.kind === 'wall' && (e.el as { cornerBoards: boolean }).cornerBoards && !['brick', 'stone', 'stucco', 'plain'].includes((e.el as { material: string }).material));
  if (cornerWall) {
    const b = bboxOf(cornerWall.poly);
    if (b.x1 - b.x0 > 4 && b.y1 - b.y0 > 3) {
      const left = midX >= (b.x0 + b.x1) / 2 ? false : true;
      const x = left ? b.x1 - 2.25 * IN : b.x0 + 2.25 * IN;
      const y = b.y0 + (b.y1 - b.y0) * 0.55;
      if (!frontOf(idx(cornerWall)).some((r) => pointInPolygon({ x, y }, r.poly))) push({ key: 'wall:corner', text: 'CORNER BOARD (TYP.)', anchor: { x, y }, priority: 4 });
    }
  }

  // Windows.
  const windows = els.filter((e) => e.el.kind === 'window') as (WorldEl & { el: WindowEl })[];
  if (windows.length) {
    const trimmed = windows.filter((w) => w.el.trim);
    if (trimmed.length) {
      const w = trimmed.reduce((best, c) => (Math.abs(c.rect!.x0 - ctx.houseX0) < Math.abs(best.rect!.x0 - ctx.houseX0) ? c : best), trimmed[0]);
      const r = w.rect!;
      const cands = trimmed.flatMap((t) => {
        const rr = t.rect!;
        const tw = Math.min(3.5 * IN, 0.13 * Math.min(rr.x1 - rr.x0, rr.y1 - rr.y0)) / 2;
        return [
          { x: rr.x0 + tw, y: (rr.y0 + rr.y1) / 2 },
          { x: rr.x1 - tw, y: (rr.y0 + rr.y1) / 2 },
        ];
      });
      push({ key: 'window:trim', text: `TRIM SURROUND${trimmed.length > 1 ? ' (TYP.)' : ''}`, anchor: { x: r.x0 + 1.5 * IN, y: (r.y0 + r.y1) / 2 }, candidates: cands, priority: 7 });
    }
    const styles = [...new Set(windows.map((w) => w.el.style))];
    for (const st of styles) {
      const group = windows.filter((w) => w.el.style === st);
      const w = group.reduce((best, c) => (Math.abs(c.rect!.x1 - ctx.houseX1) < Math.abs(best.rect!.x1 - ctx.houseX1) ? c : best), group[0]);
      const r = w.rect!;
      const grid = group.some((g) => g.el.grid !== 'none') ? ' W/ GRILLES' : '';
      const t = w.el.trim ? Math.min(3.5 * IN, 0.13 * Math.min(r.x1 - r.x0, r.y1 - r.y0)) : 0;
      const size = st === 'round' || st === 'octagon' || st === 'half-round' ? '' : `${size2(r.x1 - r.x0 - 2 * t, r.y1 - r.y0 - 2 * t)} `;
      const text = `${group.length > 1 ? '' : size}${WINDOW_TEXT[st]}${grid}${group.length > 1 ? ' (TYP.)' : ''}`;
      const glassPt = (rr: typeof r) => ({ x: (rr.x0 + rr.x1) / 2 + (rr.x1 - rr.x0) * 0.15, y: rr.y0 + (rr.y1 - rr.y0) * 0.72 });
      push({ key: `window:${st}`, text, anchor: glassPt(r), candidates: group.map((g) => glassPt(g.rect!)), priority: 6 });
    }
    const shuttered = windows.filter((w) => w.el.shutters);
    if (shuttered.length) {
      const r = shuttered[0].rect!;
      const cands = shuttered.flatMap((w) => {
        const rr = w.rect!;
        return [
          { x: rr.x0 - 0.5, y: (rr.y0 + rr.y1) / 2 },
          { x: rr.x1 + 0.5, y: (rr.y0 + rr.y1) / 2 },
        ];
      });
      push({ key: 'window:shutters', text: 'DECORATIVE SHUTTERS (TYP.)', anchor: { x: r.x0 - 0.5, y: (r.y0 + r.y1) / 2 }, candidates: cands, priority: 5 });
    }
  }

  // Doors.
  const doors = els.filter((e) => e.el.kind === 'door') as (WorldEl & { el: DoorEl })[];
  doors.slice(0, 2).forEach((d, i) => {
    const r = d.rect!;
    const el = d.el;
    const t = el.trim ? Math.min(4.5 * IN, (r.x1 - r.x0) * 0.07) : 0;
    let w = r.x1 - r.x0 - 2 * t;
    let h = r.y1 - r.y0 - t;
    if (el.transom) h -= Math.min(Math.max((r.y1 - r.y0) * 0.17, 1.0), 1.6) + 2.5 * IN;
    const sl = el.sidelights === 'both' ? 2 : el.sidelights === 'none' ? 0 : 1;
    if (sl) w -= sl * (Math.min(Math.max(w * 0.2, 0.8), 1.35) + 2 * IN);
    const extras = [sl ? 'SIDELIGHTS' : '', el.transom ? 'TRANSOM' : ''].filter(Boolean).join(' & ');
    const text = `${size2(w, h)} ${DOOR_TEXT[el.style]}${extras ? ` W/ ${extras}` : ''}`;
    push({ key: `door:${el.id}`, text, anchor: { x: (r.x0 + r.x1) / 2, y: r.y0 + (r.y1 - r.y0) * 0.62 }, priority: 8 - i });
  });

  // Garage doors.
  const garages = els.filter((e) => e.el.kind === 'garage') as (WorldEl & { el: GarageEl })[];
  const seenSizes = new Set<string>();
  for (const g of garages) {
    const r = g.rect!;
    const t = g.el.trim ? Math.min(5.5 * IN, (r.x1 - r.x0) * 0.05, (r.y1 - r.y0) * 0.08) : 0;
    const size = size2(r.x1 - r.x0 - 2 * t, r.y1 - r.y0 - t);
    if (seenSizes.has(size)) continue;
    seenSizes.add(size);
    const same = garages.filter((o) => {
      const rr = o.rect!;
      return Math.abs(rr.x1 - rr.x0 - (r.x1 - r.x0)) < 0.5;
    }).length;
    const style = g.el.style === 'carriage' ? 'CARRIAGE-STYLE GARAGE DOOR' : 'OVERHEAD GARAGE DOOR';
    const pt = (rr: typeof r) => ({ x: rr.x0 + (rr.x1 - rr.x0) * 0.3, y: rr.y0 + (rr.y1 - rr.y0) * 0.45 });
    const cands = garages.filter((o) => Math.abs(o.rect!.x1 - o.rect!.x0 - (r.x1 - r.x0)) < 0.5).flatMap((o) => [pt(o.rect!), { x: o.rect!.x1 - (o.rect!.x1 - o.rect!.x0) * 0.3, y: pt(o.rect!).y }]);
    push({ key: `garage:${size}`, text: `${size} ${style}${same > 1 ? ' (TYP.)' : ''}`, anchor: pt(r), candidates: cands, priority: 8 });
  }

  // Other elements.
  const firstOf = (k: HouseElement['kind']) => els.find((e) => e.el.kind === k);
  const vent = firstOf('vent');
  if (vent) {
    const b = bboxOf(vent.poly);
    push({ key: 'vent', text: 'GABLE VENT / LOUVER', anchor: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }, priority: 4 });
  }
  const columns = els.filter((e) => e.el.kind === 'column');
  if (columns.length) {
    const c = columns[columns.length - 1];
    const r = c.rect!;
    const style = (c.el as { style: string }).style;
    const size = ctx.metric ? `${Math.max(100, Math.round(((r.x1 - r.x0) * 304.8) / 10) * 10)} MM` : `${Math.max(4, Math.round((r.x1 - r.x0) * 12))}"`;
    const text = style === 'tapered' ? 'TAPERED COLUMN ON PEDESTAL' : style === 'round' ? `${size} ROUND COLUMN` : `${size} SQUARE COLUMN`;
    const pt = (rr: typeof r) => ({ x: (rr.x0 + rr.x1) / 2, y: rr.y0 + (rr.y1 - rr.y0) * 0.55 });
    push({ key: 'column', text: `${text}${columns.length > 1 ? ' (TYP.)' : ''}`, anchor: pt(r), candidates: columns.map((cc) => pt(cc.rect!)), priority: 6 });
  }
  const chimney = firstOf('chimney');
  if (chimney) {
    const m = (chimney.el as { material: string }).material.toUpperCase();
    const a = anchorIn(chimney);
    if (a) push({ key: 'chimney', text: `${m === 'SIDING' ? 'SIDED' : m} CHIMNEY W/ CAP`, anchor: a, priority: 5 });
  }
  const railing = firstOf('railing');
  if (railing) {
    const r = railing.rect!;
    push({ key: 'railing', text: 'PORCH RAILING W/ BALUSTERS', anchor: { x: (r.x0 + r.x1) / 2, y: r.y1 - 2 * IN }, priority: 4 });
  }
  const steps = firstOf('steps');
  if (steps) {
    const r = steps.rect!;
    push({ key: 'steps', text: 'CONCRETE STEPS', anchor: { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }, priority: 3 });
  }
  const trims = els.filter((e) => e.el.kind === 'trim');
  if (trims.length) {
    const t = trims[0].rect!;
    const text = t.y0 < 4 ? 'WATER TABLE TRIM' : t.x1 - t.x0 > (t.y1 - t.y0) * 3 ? 'FRIEZE / BAND BOARD' : 'TRIM BOARD';
    push({ key: 'trim', text, anchor: { x: t.x0 + (t.x1 - t.x0) * 0.2, y: (t.y0 + t.y1) / 2 }, priority: 4 });
  }
  const light = firstOf('light');
  if (light) {
    const r = light.rect!;
    push({ key: 'light', text: 'EXTERIOR LIGHT FIXTURE', anchor: { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }, priority: 2 });
  }

  push({ key: 'grade', text: 'APPROXIMATE FINISH GRADE', anchor: { x: ctx.houseX1 - 1.5, y: 0 }, priority: 5, side: 'right' });

  // Decorative detail tags (section-bubble style) on a few key elements.
  if (project.annotations.showDetailTags) {
    const targets: { e: WorldEl; label: string }[] = [];
    const mainGable = gables[0] ?? [...roofs].sort((a, b) => roofArea(b) - roofArea(a))[0];
    if (mainGable) targets.push({ e: mainGable, label: 'ET-1' });
    if (doors[0]) targets.push({ e: doors[0], label: 'ET-2' });
    if (garages[0]) targets.push({ e: garages[0], label: 'ET-2' });
    targets.slice(0, 3).forEach((t, i) => {
      const b = bboxOf(t.e.poly);
      const a = t.e.rect
        ? { x: t.e.rect.x0 + (t.e.rect.x1 - t.e.rect.x0) * 0.82, y: t.e.rect.y0 + (t.e.rect.y1 - t.e.rect.y0) * 0.86 }
        : visibleAnchor(t.e.poly, frontOf(idx(t.e)), (b.x0 + b.x1) / 2, used);
      if (a) push({ key: `tag:${i}`, text: '', tag: { top: String(i + 1), bottom: t.label }, anchor: a, priority: 3.5 });
    });
  }

  // Custom callouts added by the user.
  for (const c of project.customCallouts) {
    push({ key: `custom:${c.id}`, text: c.text, anchor: pxToWorld(ctx.frame, c.anchor), priority: 10, side: c.side, custom: true });
  }

  // Apply user overrides.
  for (const s of specs) {
    const o = project.calloutOverrides[s.key];
    if (!o) continue;
    if (o.text !== undefined) s.text = o.text;
    if (o.enabled !== undefined) s.enabled = o.enabled;
    if (o.side) s.side = o.side;
  }
  return specs;
}
