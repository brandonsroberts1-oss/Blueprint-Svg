import type { Vec } from '../geometry/vec';
import type { Analysis, DetectedElement } from '../shared/analysisSchema';
import { type GaussN, fitGaussN, mahalN, nllN, rgbaToLab, textureGrid } from './color';
import { type Detection, boxH, boxW, coverage, nms } from './decode';
import { type Mask, closeMask, columnProfile, componentMask, components, douglasPeucker, fillHoles, maskWhere, openMask } from './mask';
import { ADE, GROUND_CLASSES, HOUSE_CLASSES, SKY_CLASSES, VEG_CLASSES } from './models';
import { type Raster, resample } from './raster';

/** Optional diagnostics sink (used by the evaluation harness). */
export const autotraceDebug: { log?: (msg: string) => void } = {};

/** Semantic class map aligned with the photo. */
export interface SegGrid {
  w: number;
  h: number;
  /** ADE20K class id per grid pixel. */
  cls: Uint8Array;
  /** Grid pixels per photo pixel. */
  scale: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface HouseParseInput {
  photo: Raster;
  seg: SegGrid;
  /** Detections in photo pixels, labels normalised to window/door/garage/light/chimney/column/porch/stairs. */
  detections: Detection[];
  /** Main-wall rectangle from the straighten step (photo pixels), if known. */
  wallHint?: Rect | null;
}

export interface HouseParseDebug {
  w: number;
  h: number;
  scale: number;
  house: Mask;
  /** Per grid pixel: 0 not house / unknown, 1 roof, 2 wall. */
  label: Uint8Array;
  top: Float64Array;
  eave: Float64Array;
  groundY: number;
  span: [number, number];
  separation: number;
  notes: string[];
  /** Openings (grid pixels), raw roofline and which roofline columns are trustworthy. */
  openings?: Rect[];
  topRaw?: Float64Array;
  topReliable?: Uint8Array;
  veg?: Mask;
  llr?: Float32Array;
  contrast?: Float32Array;
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};
const quantile = (a: number[], q: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

function blank(kind: string): DetectedElement {
  return {
    kind,
    description: '',
    box: null,
    polygon: null,
    material: null,
    windowStyle: null,
    grid: null,
    gridCols: null,
    gridRows: null,
    units: null,
    shutters: null,
    doorStyle: null,
    sidelights: null,
    transom: null,
    garageStyle: null,
    garageSections: null,
    garageWindows: null,
    ventShape: null,
    columnStyle: null,
  };
}

/** Median filter of a 1-D profile, ignoring NaNs. */
function medianFilter(v: Float64Array, r: number): Float64Array {
  const out = new Float64Array(v.length).fill(NaN);
  for (let i = 0; i < v.length; i++) {
    const win: number[] = [];
    for (let j = Math.max(0, i - r); j <= Math.min(v.length - 1, i + r); j++) if (!isNaN(v[j])) win.push(v[j]);
    if (win.length) out[i] = median(win);
  }
  return out;
}

/**
 * 1-D grey-scale morphology on a profile y(x) (image y grows downwards).
 * 'open' removes downward dips narrower than 2r+1; 'close' removes upward spikes.
 */
function profileMorph(v: Float64Array, a: number, b: number, r: number, op: 'open' | 'close') {
  const pass = (src: Float64Array, useMax: boolean) => {
    const out = Float64Array.from(src);
    for (let x = a; x <= b; x++) {
      let m = useMax ? -Infinity : Infinity;
      for (let k = Math.max(a, x - r); k <= Math.min(b, x + r); k++) m = useMax ? Math.max(m, src[k]) : Math.min(m, src[k]);
      out[x] = m;
    }
    return out;
  };
  const res = op === 'open' ? pass(pass(v, false), true) : pass(pass(v, true), false);
  for (let x = a; x <= b; x++) v[x] = res[x];
}

/** Fill NaN gaps inside [a, b] by linear interpolation (ends are extended). */
function fillGaps(v: Float64Array, a: number, b: number) {
  let last = -1;
  for (let i = a; i <= b; i++) {
    if (isNaN(v[i])) continue;
    if (last === -1) for (let k = a; k < i; k++) v[k] = v[i];
    else for (let k = last + 1; k < i; k++) v[k] = v[last] + ((v[i] - v[last]) * (k - last)) / (i - last);
    last = i;
  }
  if (last !== -1) for (let k = last + 1; k <= b; k++) v[k] = v[last];
}

/** Simplify a profile y(x) over [a, b] into a polyline and make near-level runs exactly level. */
function profilePolyline(v: Float64Array, a: number, b: number, eps: number, flatSlope = 0.12): Vec[] {
  const pts: Vec[] = [];
  for (let x = a; x <= b; x++) if (!isNaN(v[x])) pts.push({ x, y: v[x] });
  if (pts.length < 2) return pts;
  const s = douglasPeucker(pts, eps);
  // Level the near-horizontal segments (eaves, ridges): average y weighted by length.
  for (let i = 0; i < s.length - 1; i++) {
    const p = s[i];
    const q = s[i + 1];
    if (Math.abs(q.y - p.y) <= Math.max(1, flatSlope * Math.abs(q.x - p.x))) {
      const y = (p.y + q.y) / 2;
      p.y = y;
      q.y = y;
    }
  }
  return s;
}

/**
 * Split a profile into level runs: the piecewise-constant fit with the least squared error
 * plus `penalty` per run (dynamic programming over run starts). Runs shorter than `minLen`,
 * or within `tol` of a neighbour, are folded into that neighbour. Levels are run medians.
 */
function levelRuns(v: Float64Array, a: number, b: number, penalty: number, minLen: number, tol: number): { a: number; b: number; y: number }[] {
  const n = b - a + 1;
  const S1 = new Float64Array(n + 1);
  const S2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    S1[i + 1] = S1[i] + v[a + i];
    S2[i + 1] = S2[i] + v[a + i] * v[a + i];
  }
  const best = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1);
  best[0] = 0;
  for (let j = 1; j <= n; j++)
    for (let i = 0; i < j; i++) {
      const sum = S1[j] - S1[i];
      const c = best[i] + S2[j] - S2[i] - (sum * sum) / (j - i) + penalty;
      if (c < best[j]) {
        best[j] = c;
        prev[j] = i;
      }
    }
  const runs: { a: number; b: number; y: number }[] = [];
  for (let j = n; j > 0; j = prev[j]) runs.unshift({ a: a + prev[j], b: a + j - 1, y: 0 });
  const level = (r: { a: number; b: number }) => median(Array.from(v.subarray(r.a, r.b + 1)));
  for (const r of runs) r.y = level(r);
  for (let changed = true; changed && runs.length > 1; ) {
    changed = false;
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k];
      const p = runs[k - 1];
      const q = runs[k + 1];
      const short = r.b - r.a + 1 < minLen;
      if (!short && !(p && Math.abs(p.y - r.y) <= tol) && !(q && Math.abs(q.y - r.y) <= tol)) continue;
      const t = !p ? q : !q ? p : Math.abs(p.y - r.y) <= Math.abs(q.y - r.y) ? p : q;
      t.a = Math.min(t.a, r.a);
      t.b = Math.max(t.b, r.b);
      t.y = level(t);
      runs.splice(k, 1);
      changed = true;
      break;
    }
  }
  return runs;
}

/**
 * Turn the segmentation, the detections and the photo into a traced elevation:
 * wall rectangles per wing, roof and gable polygons, and openings.
 */
export function parseHouse(input: HouseParseInput): { analysis: Analysis; debug: HouseParseDebug | null } {
  const { w, h, cls, scale: f } = input.seg;
  const N = w * h;
  const notes: string[] = [];
  const fail = (why: string): { analysis: Analysis; debug: null } => ({
    analysis: { houseFound: false, groundY: input.photo.height * 0.9, stories: 1, architecturalStyle: '', elements: [], notes: why },
    debug: null,
  });

  const houseRaw = maskWhere(w, h, (i) => HOUSE_CLASSES.has(cls[i]));
  const veg = maskWhere(w, h, (i) => VEG_CLASSES.has(cls[i]));
  const hint = input.wallHint ? { x0: input.wallHint.x0 * f, y0: input.wallHint.y0 * f, x1: input.wallHint.x1 * f, y1: input.wallHint.y1 * f } : null;

  // ---------------------------------------------------------------- main house region
  const opened = openMask(houseRaw, 1);
  const { labels, comps } = components(opened);
  const big = comps.filter((c) => c.area >= 0.008 * N);
  if (!big.length) return fail('No house found in the photo.');
  const overlap = (c: { x0: number; y0: number; x1: number; y1: number }, r: Rect) => {
    const ow = Math.min(c.x1, r.x1) - Math.max(c.x0, r.x0);
    const oh = Math.min(c.y1, r.y1) - Math.max(c.y0, r.y0);
    return ow > 0 && oh > 0 ? (ow * oh) / Math.max(1, (r.x1 - r.x0) * (r.y1 - r.y0)) : 0;
  };
  // Openings (windows, doors, garage doors) anchor the main house: neighbours' sheds and fences have none.
  const anchors = input.detections
    .filter((d) => (d.label === 'window' || d.label === 'door' || d.label === 'garage') && d.score >= 0.15)
    .map((d) => ({ x: ((d.x0 + d.x1) / 2) * f, y: ((d.y0 + d.y1) / 2) * f }));
  const openingsIn = (c: { label: number; x0: number; x1: number; y0: number; y1: number }) =>
    anchors.filter((a) => a.x >= c.x0 && a.x <= c.x1 && a.y >= c.y0 && a.y <= c.y1 && labels[Math.round(a.y) * w + Math.round(a.x)] === c.label).length;
  let best = big[0];
  let bestScore = -1;
  for (const c of big) {
    const cx = (c.x0 + c.x1) / 2;
    let s = c.area * (1 - (0.6 * Math.abs(cx - w / 2)) / (w / 2)) * (1 + 0.6 * openingsIn(c));
    if (hint) s *= 1 + 3 * overlap(c, hint);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const chosen = new Set([best.label]);
  const box = { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 };
  // Pull in pieces of the same house split apart by a tree in front of it — but not neighbours:
  // a piece must be close, stand on the same ground, overlap in height and be substantial or have openings.
  for (let pass = 0; pass < 4; pass++) {
    let merged = false;
    for (const c of big) {
      if (chosen.has(c.label)) continue;
      const vo = Math.min(c.y1, box.y1) - Math.max(c.y0, box.y0);
      if (vo < 0.5 * Math.min(c.y1 - c.y0, box.y1 - box.y0)) continue;
      if (Math.abs(c.y1 - box.y1) > 0.12 * (box.y1 - box.y0)) continue;
      if (c.area < 0.2 * best.area && openingsIn(c) === 0) continue;
      const gap = c.x0 > box.x1 ? c.x0 - box.x1 : box.x0 > c.x1 ? box.x0 - c.x1 : 0;
      if (gap > 0.05 * w) continue;
      if (gap > 3) {
        const gx0 = c.x0 > box.x1 ? box.x1 + 1 : c.x1 + 1;
        const gy0 = Math.max(c.y0, box.y0);
        const gy1 = Math.min(c.y1, box.y1);
        let v = 0;
        let n = 0;
        for (let y = gy0; y <= gy1; y++)
          for (let x = gx0; x < gx0 + gap; x++) {
            n++;
            v += veg.data[y * w + x];
          }
        if (v < 0.5 * n) continue;
      }
      chosen.add(c.label);
      box.x0 = Math.min(box.x0, c.x0);
      box.y0 = Math.min(box.y0, c.y0);
      box.x1 = Math.max(box.x1, c.x1);
      box.y1 = Math.max(box.y1, c.y1);
      merged = true;
    }
    if (!merged) break;
  }
  const house = fillHoles(closeMask(componentMask(labels, w, h, (l) => chosen.has(l)), 2));

  // ---------------------------------------------------------------- extents, ground, roofline
  const { top, bottom } = columnProfile(house);
  let x0 = box.x0;
  let x1 = box.x1;
  const heights: number[] = [];
  for (let x = x0; x <= x1; x++) if (!isNaN(top[x])) heights.push(bottom[x] - top[x]);
  const tall = quantile(heights, 0.9);
  // Trim thin slivers at the ends (fences, lamp posts, neighbouring roofs).
  while (x0 < x1 && (isNaN(top[x0]) || bottom[x0] - top[x0] < 0.2 * tall)) x0++;
  while (x1 > x0 && (isNaN(top[x1]) || bottom[x1] - top[x1] < 0.2 * tall)) x1--;
  if (x1 - x0 < 0.05 * w) return fail('The house is too small in the photo to trace.');

  const reliableBottoms: number[] = [];
  const allBottoms: number[] = [];
  for (let x = x0; x <= x1; x++) {
    if (isNaN(bottom[x])) continue;
    allBottoms.push(bottom[x]);
    const b = bottom[x];
    let ground = b >= h - 1;
    for (let y = b; y < Math.min(h, b + 3) && !ground; y++) if (GROUND_CLASSES.has(cls[y * w + x])) ground = true;
    if (ground) reliableBottoms.push(b);
  }
  let groundG = reliableBottoms.length > 0.15 * (x1 - x0) ? quantile(reliableBottoms, 0.6) : quantile(allBottoms, 0.8);

  const tops: number[] = [];
  for (let x = x0; x <= x1; x++) if (!isNaN(top[x])) tops.push(top[x]);
  const roofTop = quantile(tops, 0.15);
  let Hh = groundG - roofTop;
  // A roofline column is trustworthy when sky is right above it, or when the outline there is a clean straight
  // line (a roof in front of trees) rather than the ragged edge of foliage hiding the roof.
  const topReliable = new Uint8Array(w);
  {
    const line = profilePolyline(top, x0, x1, Math.max(1, 0.012 * Hh), 0.05);
    const at = (x: number) => {
      for (let k = 0; k < line.length - 1; k++)
        if (x >= line[k].x && x <= line[k + 1].x) return line[k].y + ((line[k + 1].y - line[k].y) * (x - line[k].x)) / Math.max(1e-9, line[k + 1].x - line[k].x);
      return NaN;
    };
    const tol = Math.max(1, 0.012 * Hh);
    for (let x = x0; x <= x1; x++) {
      const t = top[x];
      if (isNaN(t) || t <= 1) continue;
      let skyAbove = false;
      for (let y = Math.max(0, t - 3); y < t; y++) if (SKY_CLASSES.has(cls[y * w + x])) skyAbove = true;
      let clean = !veg.data[Math.min(h - 1, t + 1) * w + x];
      for (let k = Math.max(x0, x - 3); k <= Math.min(x1, x + 3) && clean; k++) if (!(Math.abs(top[k] - at(k)) <= tol)) clean = false;
      if (skyAbove || clean) topReliable[x] = 1;
    }
  }
  if (hint && Math.abs(hint.y1 - groundG) < 0.12 * Hh) {
    groundG = hint.y1;
    Hh = groundG - roofTop;
  }
  if (!(Hh > 0.05 * h)) return fail('Could not find where the house meets the ground.');
  // End stretches that float well above the ground on something other than bushes or cars (a neighbour's
  // shed seen over a fence, say) are not part of this house's front.
  {
    const floating = (x: number) => {
      const b = bottom[x];
      if (isNaN(b)) return true;
      if (b >= groundG - 0.3 * Hh) return false;
      let hidden = 0;
      for (let y = Math.ceil(b) + 1; y < groundG; y++) if (VEG_CLASSES.has(cls[y * w + x]) || cls[y * w + x] === ADE.car) hidden++;
      return hidden < 0.5 * (groundG - b);
    };
    const lim = 0.3 * (x1 - x0);
    let a = x0;
    while (a < x0 + lim && floating(a)) a++;
    let b = x1;
    while (b > x1 - lim && floating(b)) b--;
    if (a - x0 >= 0.05 * (x1 - x0) && a < x0 + lim) x0 = a;
    if (x1 - b >= 0.05 * (x1 - x0) && b > x1 - lim) x1 = b;
  }

  // ---------------------------------------------------------------- openings in grid space
  const G = (d: Detection) => ({ x0: d.x0 * f, y0: d.y0 * f, x1: d.x1 * f, y1: d.y1 * f });
  const inHouse = (d: Detection) => {
    const cx = Math.round(((d.x0 + d.x1) / 2) * f);
    const cy = Math.round(((d.y0 + d.y1) / 2) * f);
    if (cx < x0 - 2 || cx > x1 + 2 || cy < roofTop - 2 || cy > groundG + 2) return false;
    return house.data[Math.min(h - 1, Math.max(0, cy)) * w + Math.min(w - 1, Math.max(0, cx))] === 1;
  };
  // Weak detections must sit on the house in the class map (a flower bed or a fence is no garage door), and
  // shape decides between look-alikes: blurry photos often call a front door a window or a garage door.
  const notHouse = (c: number) => VEG_CLASSES.has(c) || SKY_CLASSES.has(c) || GROUND_CLASSES.has(c) || c === ADE.fence;
  const outsideFrac = (d: Detection) => {
    const b = G(d);
    const mx = 0.2 * (b.x1 - b.x0);
    const my = 0.2 * (b.y1 - b.y0);
    let n = 0;
    let bad = 0;
    for (let y = Math.max(0, Math.round(b.y0 + my)); y <= Math.min(h - 1, Math.round(b.y1 - my)); y++)
      for (let x = Math.max(0, Math.round(b.x0 + mx)); x <= Math.min(w - 1, Math.round(b.x1 - mx)); x++) {
        n++;
        if (notHouse(cls[y * w + x])) bad++;
      }
    return n ? bad / n : 1;
  };
  // A car parked in front can hide most of a garage door: only the visible strip gets detected.
  const carBeside = (d: Detection) => {
    const b = G(d);
    const bw = b.x1 - b.x0;
    let n = 0;
    let car = 0;
    for (let y = Math.max(0, Math.round(b.y0)); y <= Math.min(h - 1, Math.round(b.y1)); y++)
      for (let x = Math.max(0, Math.round(b.x0 - bw)); x <= Math.min(w - 1, Math.round(b.x1 + bw)); x++) {
        n++;
        if (cls[y * w + x] === ADE.car) car++;
      }
    return n > 0 && car >= 0.12 * n;
  };
  const dets: Detection[] = [];
  {
    const Hp = Hh / f;
    const gp = groundG / f;
    const spanP = (x1 - x0) / f;
    for (let d of input.detections.filter(inHouse)) {
      const isOpening = d.label === 'window' || d.label === 'door' || d.label === 'garage';
      if (isOpening && d.score < 0.3 && outsideFrac(d) > 0.5) continue;
      const bw = boxW(d);
      const bh = boxH(d);
      const grounded = gp - d.y1 <= 0.16 * Hp && d.y1 - gp <= 0.1 * Hp;
      const doorShaped = bh >= 1.5 * bw && bh <= 3.3 * bw && bh >= 0.3 * Hp && bh <= 0.8 * Hp;
      if ((d.label === 'window' || (d.label === 'garage' && d.score >= 0.15)) && grounded && doorShaped) d = { ...d, label: 'door' };
      else if (d.label === 'garage' && (bw < 0.9 * bh || bw < 0.07 * spanP) && !carBeside(d)) {
        if (d.score < 0.2) continue;
        d = { ...d, label: grounded ? 'door' : 'window' };
      }
      dets.push(d);
    }
  }
  const openings = dets.filter((d) => d.label === 'window' || d.label === 'door' || d.label === 'garage');

  // ---------------------------------------------------------------- roof / wall colour models
  const small = resample(input.photo, w, h);
  const lab = rgbaToLab(small.data, N);
  // Colour plus texture (edge energy across and along) per grid pixel: shingles and tile are busy both ways,
  // lap siding mostly along, stucco hardly at all.
  const tex = textureGrid(input.photo.data, input.photo.width, input.photo.height, w, h);
  const D = 5;
  const feat = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    feat[i * D] = lab[i * 3];
    feat[i * D + 1] = lab[i * 3 + 1];
    feat[i * D + 2] = lab[i * 3 + 2];
    feat[i * D + 3] = 2 * tex.tx[i];
    feat[i * D + 4] = 2 * tex.ty[i];
  }
  const MINVAR = [9, 9, 9, 2, 2];
  const fitModel = (idx: ArrayLike<number>) => fitGaussN(feat, D, idx, MINVAR);
  const inOpening = new Uint8Array(N);
  for (const d of openings) {
    const b = G(d);
    for (let y = Math.max(0, Math.floor(b.y0)); y < Math.min(h, Math.ceil(b.y1)); y++)
      for (let x = Math.max(0, Math.floor(b.x0)); x < Math.min(w, Math.ceil(b.x1)); x++) inOpening[y * w + x] = 1;
  }
  const usable = (i: number) => house.data[i] === 1 && veg.data[i] === 0 && inOpening[i] === 0;

  // ---------------------------------------------------------------- eave line: strongest continuous colour break
  const topFilled = Float64Array.from(top);
  fillGaps(topFilled, x0, x1);
  const lo = new Int32Array(w);
  const hi = new Int32Array(w);
  const occluded = new Uint8Array(w);
  for (let x = x0; x <= x1; x++) {
    lo[x] = Math.round(topFilled[x]) + 1;
    let limit = groundG - 0.22 * Hh;
    for (const d of openings) {
      const b = G(d);
      if (x >= b.x0 && x <= b.x1 && b.y0 > topFilled[x] + 2) limit = Math.min(limit, b.y0 - 1);
    }
    hi[x] = Math.floor(limit);
    let v = 0;
    for (let y = lo[x]; y < groundG; y++) v += veg.data[y * w + x];
    occluded[x] = v > 0.5 * (groundG - lo[x]) ? 1 : 0;
  }
  // Eaves don't dip between windows of the same floor: bridge the limit across gaps between openings at similar heights.
  const ob = openings.map(G).sort((a, b) => a.x0 - b.x0);
  for (let i = 0; i < ob.length; i++)
    for (let j = i + 1; j < ob.length; j++) {
      const a = ob[i];
      const b = ob[j];
      if (b.x0 <= a.x1 || b.x0 - a.x1 > 0.3 * (x1 - x0) || Math.abs(a.y0 - b.y0) > 0.12 * Hh) continue;
      const lim = Math.min(a.y0, b.y0) - 1;
      for (let x = Math.max(x0, Math.floor(a.x1)); x <= Math.min(x1, Math.ceil(b.x0)); x++) if (lim > topFilled[x] + 2) hi[x] = Math.min(hi[x], Math.floor(lim));
    }
  for (let x = x0; x <= x1; x++) hi[x] = Math.max(lo[x], hi[x]);
  const bandK = Math.max(2, Math.round(0.03 * Hh));
  const contrast = verticalContrast(lab, w, h, bandK, x0, x1, lo, hi, topFilled);
  for (let x = x0; x <= x1; x++) if (occluded[x]) for (let y = lo[x]; y <= hi[x]; y++) contrast[y * w + x] = 0;
  // Eaves are long level lines: favour rows where strong breaks run across much of the house.
  {
    const support = new Float64Array(h);
    let cols = 0;
    for (let x = x0; x <= x1; x++) {
      if (occluded[x]) continue;
      cols++;
      for (let y = lo[x]; y <= hi[x]; y++) {
        let m = 0;
        for (let yy = Math.max(lo[x], y - 1); yy <= Math.min(hi[x], y + 1); yy++) m = Math.max(m, contrast[yy * w + x]);
        if (m >= 0.5) support[y]++;
      }
    }
    if (cols > 0) for (let x = x0; x <= x1; x++) if (!occluded[x]) for (let y = lo[x]; y <= hi[x]; y++) contrast[y * w + x] += 0.6 * (support[y] / cols);
  }
  const roofSide = roofSideCost(lab, w, x0, x1, lo, hi, topFilled, bandK, Math.max(2, Math.round(0.03 * Hh)), Math.max(2, Math.round(0.03 * (x1 - x0))), (x) => topReliable[x] === 1, (i) => house.data[i] === 1 && veg.data[i] === 0 && inOpening[i] === 0);
  if (roofSide) for (let x = x0; x <= x1; x++) if (occluded[x]) for (let y = lo[x]; y <= hi[x]; y++) roofSide[y * w + x] = 0;

  // Initial colour models: roof from the band just under the roofline, wall from beside the openings —
  // at their own height, never above them (eaves often sit right on top of the windows).
  const ringSeeds: number[] = [];
  for (const d of openings) {
    const b = G(d);
    const bh = b.y1 - b.y0;
    const m = Math.max(2, Math.min(0.35 * (b.x1 - b.x0), 0.06 * (x1 - x0)));
    for (let y = Math.max(0, Math.floor(b.y0 + 0.15 * bh)); y < Math.min(h, groundG, Math.ceil(b.y1 + 0.25 * bh)); y++)
      for (let x = Math.max(x0, Math.floor(b.x0 - m)); x <= Math.min(x1, Math.ceil(b.x1 + m)); x++) {
        const i = y * w + x;
        if (usable(i)) ringSeeds.push(i);
      }
  }
  if (hint) {
    const mx = 0.1 * (hint.x1 - hint.x0);
    const my = 0.1 * (hint.y1 - hint.y0);
    for (let y = Math.max(0, Math.floor(hint.y0 + my)); y < Math.min(h, Math.ceil(hint.y1 - my)); y++)
      for (let x = Math.max(0, Math.floor(hint.x0 + mx)); x < Math.min(w, Math.ceil(hint.x1 - mx)); x++) if (usable(y * w + x)) ringSeeds.push(y * w + x);
  }
  let wallSeeds = ringSeeds.slice();
  if (wallSeeds.length < 60) {
    const cx0 = x0 + 0.2 * (x1 - x0);
    const cx1 = x1 - 0.2 * (x1 - x0);
    for (let y = Math.floor(groundG - 0.3 * Hh); y < groundG - 0.08 * Hh; y++)
      for (let x = Math.floor(cx0); x < cx1; x++) if (y >= 0 && y < h && usable(y * w + x)) wallSeeds.push(y * w + x);
    notes.push('No windows or doors were recognised, so the wall colour is a guess.');
  }
  // Eave heights read off the outline at both ends seed the roof and wall colours there and
  // gently pull the eave line towards them near the ends.
  const sides = sideEaves(house, x0, x1, roofTop, groundG, Hh);
  const prior = new Float64Array(w).fill(NaN);
  const priorW = new Float64Array(w);
  const endSpan = 0.25 * (x1 - x0);
  const sideRoof: number[] = [];
  for (const [yS, from, dir] of [
    [sides.left, x0, 1],
    [sides.right, x1, -1],
  ] as [number | null, number, number][]) {
    if (yS === null) continue;
    for (let k = 0; k <= endSpan; k++) {
      const x = from + dir * k;
      prior[x] = yS;
      priorW[x] = 1 - k / endSpan;
      if (k > 0.6 * endSpan) continue;
      for (let y = Math.round(topFilled[x]) + 1; y < yS - 1; y++) if (usable(y * w + x)) sideRoof.push(y * w + x);
      for (let y = Math.round(yS) + 2; y < Math.min(groundG - 1, yS + 0.12 * Hh); y++) if (usable(y * w + x)) wallSeeds.push(y * w + x);
    }
  }
  if (sides.left !== null || sides.right !== null) autotraceDebug.log?.(`side eaves: left ${sides.left?.toFixed(0)} right ${sides.right?.toFixed(0)} (top ${roofTop.toFixed(0)}, ground ${groundG.toFixed(0)})`);
  // How well two colour models tell their own samples apart (balanced accuracy).
  const separation = (rm: GaussN | null, wm: GaussN | null, roofIdx: number[], wallIdx: number[]) => {
    if (!rm || !wm || !roofIdx.length || !wallIdx.length) return 0;
    const hit = (idx: number[], roof: boolean) => {
      let n = 0;
      let m = 0;
      const step = Math.max(1, Math.floor(idx.length / 3000));
      for (let k = 0; k < idx.length; k += step, m++) if (nllN(rm, feat, idx[k]) < nllN(wm, feat, idx[k]) === roof) n++;
      return n / Math.max(1, m);
    };
    return (hit(roofIdx, true) + hit(wallIdx, false)) / 2;
  };
  // Colour only earns a say in the trace when it clearly separates roof from wall; otherwise
  // (a dark roof over dark brick, a shaded street photo) the eave is traced from edges alone.
  const regionWeight = (acc: number) => Math.max(0, Math.min(1, (acc - 0.8) / 0.12));
  let wallModel = fitModel(wallSeeds);
  let roofModel: GaussN | null = null;
  let regionW = 0;
  {
    const band = Math.max(2, Math.round(0.025 * Hh));
    const cand: number[] = [...sideRoof];
    for (let x = x0; x <= x1; x++) {
      if (!topReliable[x]) continue;
      for (let y = Math.round(topFilled[x]) + 2; y <= topFilled[x] + 1 + band && y < groundG; y++) if (usable(y * w + x)) cand.push(y * w + x);
    }
    const distinct = wallModel ? cand.filter((i) => mahalN(wallModel!, feat, i) > 9) : cand;
    roofModel = fitModel(distinct.length >= Math.max(20, 0.25 * cand.length) ? distinct : cand);
    const acc0 = separation(roofModel, wallModel, cand, wallSeeds);
    regionW = regionWeight(acc0);
    const fmt = (g: GaussN | null) => (g ? g.mean.map((v) => v.toFixed(0)).join(',') : '-');
    autotraceDebug.log?.(`init wall ${fmt(wallModel)} roof ${fmt(roofModel)} (cand ${cand.length} distinct ${distinct.length}) acc ${acc0.toFixed(2)}`);
  }

  // Alternate: trace the eave with the current models, then refit the models from the traced split.
  const llr = new Float32Array(N);
  let eave: Float64Array = new Float64Array(w).fill(NaN);
  let accuracy = 0;
  for (let iter = 0; iter < 4; iter++) {
    if (regionW > 0)
      for (let x = x0; x <= x1; x++)
        for (let y = Math.max(0, Math.round(topFilled[x])); y <= hi[x]; y++) {
          const i = y * w + x;
          llr[i] = usable(i) ? Math.max(-2, Math.min(2, 0.5 * (nllN(wallModel!, feat, i) - nllN(roofModel!, feat, i)))) : 0;
        }
    eave = traceEave(contrast, regionW > 0 ? llr : null, roofSide, topFilled, w, x0, x1, lo, hi, {
      slope: 0.15,
      jump: 6,
      region: regionW / Math.max(2, 0.15 * Hh),
      prior,
      priorW: priorW.map((v) => (2 * v) / Hh),
    });
    const roofSeeds: number[] = [...sideRoof];
    const nextWall: number[] = ringSeeds.slice();
    for (let x = x0; x <= x1; x++) {
      if (occluded[x] || isNaN(eave[x])) continue;
      // Roof samples stay near the roofline so a wrong dip can't teach the model that walls are roof;
      // a column traced with no roof teaches nothing (it may be a roof the trace missed).
      if (eave[x] - topFilled[x] < 0.05 * Hh) continue;
      for (let y = Math.round(topFilled[x]) + 2; y < Math.min(eave[x] - 1, topFilled[x] + 0.18 * Hh); y++) if (usable(y * w + x)) roofSeeds.push(y * w + x);
      for (let y = Math.round(eave[x]) + 2; y < Math.min(groundG - 1, eave[x] + 0.12 * Hh); y++) if (usable(y * w + x)) nextWall.push(y * w + x);
    }
    const rm = roofSeeds.length >= 40 ? fitModel(roofSeeds) : null;
    const wm = nextWall.length >= 40 ? fitModel(nextWall) : wallModel;
    const acc = separation(rm, wm, roofSeeds, nextWall);
    autotraceDebug.log?.(`iter ${iter}: region ${regionW.toFixed(2)} eave med ${median(Array.from(eave.subarray(x0, x1 + 1)).filter((v) => !isNaN(v)))} roofSeeds ${roofSeeds.length} wallSeeds ${nextWall.length} acc ${acc.toFixed(2)}`);
    if (!rm || !wm) break;
    roofModel = rm;
    wallModel = wm;
    wallSeeds = nextWall;
    accuracy = acc;
    // The colour term only ever loses weight, so the trace can't oscillate between two answers.
    const nextW = iter === 0 ? regionWeight(acc) : Math.min(regionW, regionWeight(acc));
    if (nextW === 0 && regionW === 0) break;
    regionW = nextW;
  }

  // ---------------------------------------------------------------- labels (debug) and lower roofs by colour clusters
  const smooth = new Uint8Array(N);
  for (let x = x0; x <= x1; x++) {
    if (isNaN(eave[x])) continue;
    for (let y = Math.max(0, Math.round(topFilled[x])); y < Math.min(h, groundG); y++) {
      const i = y * w + x;
      if (house.data[i] && !veg.data[i]) smooth[i] = y < eave[x] ? 1 : 2;
    }
  }
  const lowRoofs =
    roofModel && wallModel && accuracy >= 0.75
      ? findLowerRoofs({ w, h, x0, x1, eave, groundG, Hh, isRoof: (i) => usable(i) && nllN(roofModel!, feat, i) + 1 < nllN(wallModel!, feat, i) })
      : [];
  for (const r of lowRoofs) for (const i of r.pixels) smooth[i] = 1;
  const dip = Math.max(2, Math.round(0.05 * (x1 - x0)));
  const spike = Math.max(1, Math.round(0.015 * (x1 - x0)));
  const eaveS = medianFilter(eave, 2);
  fillGaps(eaveS, x0, x1);
  profileMorph(eaveS, x0, x1, dip, 'open');
  profileMorph(eaveS, x0, x1, spike, 'close');
  const topS = medianFilter(top, 1);
  // Where trees hide the roofline, carry the neighbouring roofline across.
  const topFixed = Float64Array.from(topS);
  {
    // Bridge short hidden stretches between two reliable columns; elsewhere keep what is visible.
    let last = -1;
    for (let x = x0; x <= x1; x++) {
      if (!topReliable[x] || isNaN(topS[x])) continue;
      if (last >= 0 && x - last > 1 && x - last <= 0.25 * (x1 - x0))
        for (let k = last + 1; k < x; k++) {
          const v = topS[last] + ((topS[x] - topS[last]) * (k - last)) / (x - last);
          topFixed[k] = isNaN(topS[k]) ? v : Math.min(topS[k], v);
        }
      last = x;
    }
    fillGaps(topFixed, x0, x1);
  }

  // ---------------------------------------------------------------- wall tops, gables, roofs
  const epsE = Math.max(1.5, 0.02 * Hh);
  const E = profilePolyline(eaveS, x0, x1, epsE);
  const minPeak = 0.07 * Hh;
  const gables: { a: number; b: number; base: number }[] = [];
  {
    // Classify simplified eave segments: level, sloped (rakes) or steep (steps between wings).
    type Seg = { p: Vec; q: Vec; kind: 'flat' | 'up' | 'down' | 'steep' };
    const segs: Seg[] = [];
    for (let i = 0; i < E.length - 1; i++) {
      const p = E[i];
      const q = E[i + 1];
      const dx = Math.max(1e-6, q.x - p.x);
      const slope = (q.y - p.y) / dx;
      const kind = Math.abs(slope) <= 0.12 ? 'flat' : Math.abs(slope) > 3.5 ? 'steep' : slope < 0 ? 'up' : 'down';
      segs.push({ p, q, kind });
    }
    const span = x1 - x0;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].kind !== 'up') continue;
      let j = i;
      while (j + 1 < segs.length && segs[j + 1].kind === 'up') j++;
      let k = j + 1;
      // Allow a short level apex.
      if (k < segs.length && segs[k].kind === 'flat' && segs[k].q.x - segs[k].p.x <= 0.15 * span) k++;
      if (k >= segs.length || segs[k].kind !== 'down') continue;
      let m = k;
      while (m + 1 < segs.length && segs[m + 1].kind === 'down') m++;
      const a = segs[i].p;
      const b = segs[m].q;
      const apex = Math.min(...segs.slice(i, m + 1).map((sg) => Math.min(sg.p.y, sg.q.y)));
      const base = Math.max(a.y, b.y);
      const left = segs[j].q.x - a.x;
      const right = b.x - segs[k].p.x;
      const width = b.x - a.x;
      if (base - apex >= minPeak && width >= 0.06 * span && Math.min(left, right) >= 0.25 * Math.max(left, right)) gables.push({ a: a.x, b: b.x, base });
      i = m;
    }
  }
  const wallTop = new Float64Array(w).fill(NaN);
  for (let x = x0; x <= x1; x++) wallTop[x] = eaveS[x];
  for (const g of gables) for (let x = Math.ceil(g.a); x <= Math.floor(g.b); x++) wallTop[x] = g.base;
  // Wings: the fewest level runs that explain the wall top — a new wing needs a clear, sustained step.
  let span = x1 - x0;
  const wings = levelRuns(wallTop, x0, x1, (0.06 * Hh) ** 2 * 0.08 * span, Math.max(3, 0.07 * span), Math.max(2, 0.04 * Hh));
  // A low end wing without windows or doors is usually a neighbour's shed or a fence seen past the house.
  {
    const wallH = (wg: { y: number }) => groundG - wg.y;
    const tallest = Math.max(...wings.map(wallH));
    const hasOpening = (wg: { a: number; b: number }) =>
      openings.some((d) => {
        const cx = ((d.x0 + d.x1) / 2) * f;
        return cx >= wg.a && cx <= wg.b;
      });
    const prunable = (wg: { a: number; b: number; y: number }) => wallH(wg) < 0.7 * tallest && !hasOpening(wg) && wg.b - wg.a < 0.25 * span;
    while (wings.length > 1 && prunable(wings[0])) wings.shift();
    while (wings.length > 1 && prunable(wings[wings.length - 1])) wings.pop();
    x0 = wings[0].a;
    x1 = wings[wings.length - 1].b;
    span = x1 - x0;
    for (let k = gables.length - 1; k >= 0; k--) if (gables[k].b < x0 || gables[k].a > x1) gables.splice(k, 1);
  }
  const levelAt = (x: number) => {
    for (const wg of wings) if (x >= wg.a && x <= wg.b) return wg.y;
    return NaN;
  };

  const P = (x: number, y: number): Vec => ({ x: x / f, y: y / f });
  const elements: DetectedElement[] = [];
  const wallMaterial = guessWallMaterial(feat, D, wallSeeds);
  const roofMaterial = roofModel ? guessRoofMaterial(roofModel) : 'shingle';

  for (const wg of wings) {
    const top0 = Math.min(wg.y, groundG - 0.2 * Hh);
    const e = blank('wall');
    e.polygon = [P(wg.a, groundG), P(wg.b + 1, groundG), P(wg.b + 1, top0), P(wg.a, top0)];
    e.material = wallMaterial;
    e.description = 'Wall (auto-traced)';
    elements.push(e);
  }

  // ---------------------------------------------------------------- roofline: chimneys out, then straight lines
  // A chimney sticks up through the roofline and stops above the wall.
  const chimneyDets = nms(
    dets.filter((d) => {
      if (d.label !== 'chimney') return false;
      const cx = Math.round(((d.x0 + d.x1) / 2) * f);
      return cx >= x0 && cx <= x1 && d.y0 * f < topFixed[cx] + 0.05 * Hh && d.y1 * f <= levelAt(cx) + 0.05 * Hh && boxW(d) * f <= 0.12 * span;
    }),
    0.3,
    true,
  );
  const topClean = Float64Array.from(topFixed);
  const chimneys: { a: number; b: number; top: number; base: number }[] = [];
  {
    const ref = Float64Array.from(topFixed);
    profileMorph(ref, x0, x1, Math.max(2, Math.round(0.045 * span)), 'close');
    const detCols = (x: number) => chimneyDets.some((d) => x >= d.x0 * f - 1 && x <= d.x1 * f + 1);
    let s0 = -1;
    for (let x = x0; x <= x1 + 1; x++) {
      const up = x <= x1 && topFixed[x] < ref[x] - Math.max(2, 0.05 * Hh);
      if (up && s0 < 0) s0 = x;
      if (up || s0 < 0) continue;
      const a = s0;
      const b = x - 1;
      s0 = -1;
      let peak = Infinity;
      for (let k = a; k <= b; k++) peak = Math.min(peak, topFixed[k]);
      const base = ref[Math.round((a + b) / 2)];
      const rise = base - peak;
      // A chimney is a narrow flat-topped block; a narrow front gable rises to a point.
      let flat = 0;
      for (let k = a; k <= b; k++) if (topFixed[k] <= peak + 0.3 * rise) flat++;
      const width = b - a + 1;
      const inside = a - x0 >= 0.03 * span && x1 - b >= 0.03 * span;
      const isChimney = detCols(Math.round((a + b) / 2)) || (inside && width >= Math.max(2, 0.012 * span) && width <= 0.08 * span && rise >= 0.06 * Hh && flat >= 0.55 * width);
      if (!isChimney) continue;
      for (let k = a; k <= b; k++) topClean[k] = ref[k];
      if (!detCols(Math.round((a + b) / 2))) chimneys.push({ a, b, top: peak, base });
    }
  }
  const epsT = Math.max(1.5, 0.025 * Hh);
  const topLine = profilePolyline(topClean, x0, x1, epsT, 0.1);
  const topReg = new Float64Array(w).fill(NaN);
  for (let k = 0; k < topLine.length - 1; k++) {
    const p = topLine[k];
    const q = topLine[k + 1];
    for (let x = Math.ceil(p.x); x <= Math.floor(q.x); x++) topReg[x] = p.y + ((q.y - p.y) * (x - p.x)) / Math.max(1e-9, q.x - p.x);
  }
  if (topLine.length === 1) topReg[Math.round(topLine[0].x)] = topLine[0].y;

  // Roofs: wherever the roof band between the straightened roofline and the wall tops is thick enough,
  // grown outwards while any roof is left (hip ends taper to the eave corner).
  const minRoof = Math.max(2, 0.035 * Hh);
  const inGable = (x: number) => gables.some((g) => x >= g.a && x <= g.b);
  const band = (x: number) => levelAt(x) - topReg[x];
  const roofSpans: [number, number][] = [];
  for (let x = x0; x <= x1; x++) {
    if (inGable(x) || !(band(x) >= minRoof)) continue;
    let a = x;
    let b = x;
    while (b + 1 <= x1 && !inGable(b + 1) && band(b + 1) >= minRoof) b++;
    while (a - 1 >= x0 && !inGable(a - 1) && band(a - 1) > 0.5) a--;
    while (b + 1 <= x1 && !inGable(b + 1) && band(b + 1) > 0.5) b++;
    if (b - a + 1 >= Math.max(3, 0.03 * span)) roofSpans.push([a, b]);
    x = b;
  }
  for (const [a, b] of roofSpans) {
    const T = profilePolyline(topReg, a, b, 0.5, 0);
    if (T.length < 2) continue;
    for (const p of T) p.y = Math.min(p.y, levelAt(Math.round(p.x)) - 1);
    T[T.length - 1] = { x: b + 1, y: T[T.length - 1].y };
    // The underside follows the wall tops, so roof and walls meet without gaps.
    const bottom: Vec[] = [];
    for (let k = wings.length - 1; k >= 0; k--) {
      const lo = Math.max(a, wings[k].a);
      const hi = Math.min(b, wings[k].b);
      if (lo <= hi) bottom.push({ x: hi + 1, y: wings[k].y }, { x: lo, y: wings[k].y });
    }
    const e = blank('roof');
    e.polygon = [...T, ...bottom].map((p) => P(p.x, p.y));
    e.material = roofMaterial;
    e.description = 'Roof (auto-traced)';
    elements.push(e);
  }

  for (const g of gables) {
    const T = profilePolyline(topReg, Math.round(g.a), Math.round(g.b), 0.5, 0).filter((p) => p.y < g.base - 1);
    if (T.length < 1) continue;
    const e = blank('gable');
    e.polygon = [P(g.a, g.base), ...T.map((p) => P(p.x, p.y)), P(g.b, g.base)];
    e.material = wallMaterial;
    e.description = 'Gable (auto-traced)';
    elements.push(e);
  }

  // Lower roofs in front of the walls (porches, garage roofs).
  for (const r of lowRoofs) {
    const tops: number[] = [];
    const bots: number[] = [];
    for (let x = r.a; x <= r.b; x++) {
      if (!isNaN(r.top[x])) tops.push(r.top[x]);
      if (!isNaN(r.bottom[x])) bots.push(r.bottom[x]);
    }
    const yt = quantile(tops, 0.3);
    const yb = quantile(bots, 0.7);
    if (!(yb - yt >= 2)) continue;
    const e = blank('roof');
    e.polygon = [P(r.a, yb), P(r.b + 1, yb), P(r.b + 1, yt), P(r.a, yt)];
    e.material = roofMaterial;
    e.description = 'Lower roof (auto-traced)';
    elements.push(e);
  }

  // ---------------------------------------------------------------- openings and fixtures
  const groundPhoto = groundG / f;
  const HhPhoto = Hh / f;
  const nearGround = (d: Detection, tolFrac: number) => Math.abs(d.y1 - groundPhoto) <= tolFrac * HhPhoto;
  // Garage doors stand on the ground and fill most of the wall's height.
  const garages = nms(
    dets.filter((d) => {
      if (d.label !== 'garage' || !nearGround(d, 0.16)) return false;
      const wallTopY = levelAt(Math.round(((d.x0 + d.x1) / 2) * f));
      const wallHt = isNaN(wallTopY) ? HhPhoto : groundPhoto - wallTopY / f;
      if (boxH(d) < 0.45 * wallHt || !(boxW(d) > boxH(d) * 0.9 || carBeside(d))) return false;
      // A recessed porch can pass for a garage door: a surer entry door inside it wins.
      return !dets.some((o) => o.label === 'door' && o.score > d.score && coverage(o, d) > 0.4);
    }),
    0.3,
    true,
  );
  const doors = nms(
    dets.filter((d) => d.label === 'door' && !garages.some((g) => coverage(d, g) > 0.4)),
    0.3,
    true,
  );
  // Nothing is glazed above the roofline or in a chimney (a chimney's flue and cap can look like a small window).
  const chimneyBoxes: Rect[] = [
    ...chimneyDets.map((d) => ({ x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 })),
    ...chimneys.map((c) => ({ x0: c.a / f, y0: c.top / f, x1: (c.b + 1) / f, y1: c.base / f })),
  ];
  const belowRoofline = (d: Detection) => {
    if (chimneyBoxes.some((c) => coverage(d, { ...c, score: 0, label: '' }) > 0.4)) return false;
    const cx = Math.round(((d.x0 + d.x1) / 2) * f);
    return cx < x0 || cx > x1 || isNaN(topClean[cx]) || d.y0 * f >= topClean[cx] - 0.03 * Hh;
  };
  const windows = nms(
    dets.filter((d) => d.label === 'window' && belowRoofline(d) && !garages.some((g) => coverage(d, g) > 0.4) && !doors.some((o) => coverage(d, o) > 0.6)),
    0.3,
    true,
  );
  for (const d of garages) {
    const e = blank('garage');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: Math.max(d.y1, groundPhoto) };
    // Only a strip shows beside a parked car: widen to a single door's proportions, behind the car.
    const bh = e.box.y1 - e.box.y0;
    if (boxW(e.box) < 1.1 * bh && carBeside(d)) {
      const b = G(d);
      const bw = b.x1 - b.x0;
      let left = 0;
      let right = 0;
      for (let y = Math.max(0, Math.round(b.y0)); y <= Math.min(h - 1, Math.round(b.y1)); y++)
        for (let k = 1; k <= bw; k++) {
          if (cls[y * w + Math.max(0, Math.round(b.x0 - k))] === ADE.car) left++;
          if (cls[y * w + Math.min(w - 1, Math.round(b.x1 + k))] === ADE.car) right++;
        }
      const want = 1.15 * bh - boxW(e.box);
      if (right >= left) e.box.x1 = Math.min((x1 + 1) / f, e.box.x1 + want);
      else e.box.x0 = Math.max(x0 / f, e.box.x0 - want);
    }
    e.garageStyle = 'raised-panel';
    e.garageSections = 4;
    e.description = 'Garage door (auto-traced)';
    elements.push(e);
  }
  for (const d of doors) {
    // Entry doors often sit a step or two above the ground.
    const e = blank(nearGround(d, 0.2) ? 'door' : 'window');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: e.kind === 'door' && nearGround(d, 0.04) ? Math.max(d.y1, groundPhoto) : d.y1 };
    if (e.kind === 'door') {
      e.doorStyle = boxW(d) > 0.75 * boxH(d) ? 'double' : 'six-panel';
      e.sidelights = 'none';
    } else e.windowStyle = 'casement';
    e.description = e.kind === 'door' ? 'Entry door (auto-traced)' : 'Window (auto-traced)';
    elements.push(e);
  }
  for (const d of windows) {
    const e = blank('window');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    const ar = boxW(d) / Math.max(1, boxH(d));
    e.windowStyle = ar > 1.7 ? 'slider' : ar > 1.15 ? 'picture' : 'double-hung';
    e.units = ar > 2.4 ? Math.min(4, Math.round(ar / 1.2)) : 1;
    e.grid = 'none';
    e.description = 'Window (auto-traced)';
    elements.push(e);
  }
  // Chimney cladding from its colour: reddish is brick, otherwise stucco.
  const chimneyMaterial = (gx0: number, gy0: number, gx1: number, gy1: number) => {
    const as: number[] = [];
    for (let y = Math.max(0, Math.round(gy0)); y <= Math.min(h - 1, Math.round(gy1)); y++)
      for (let x = Math.max(0, Math.round(gx0)); x <= Math.min(w - 1, Math.round(gx1)); x++) if (!veg.data[y * w + x]) as.push(lab[(y * w + x) * 3 + 1]);
    return median(as) > 8 ? 'brick' : 'stucco';
  };
  for (const d of chimneyDets) {
    const e = blank('chimney');
    e.polygon = [P(d.x0 * f, d.y1 * f), P(d.x1 * f, d.y1 * f), P(d.x1 * f, d.y0 * f), P(d.x0 * f, d.y0 * f)];
    e.material = chimneyMaterial(d.x0 * f, d.y0 * f, d.x1 * f, d.y1 * f);
    elements.push(e);
  }
  for (const c of chimneys) {
    const yb = Math.min(levelAt(Math.round((c.a + c.b) / 2)), c.base + 0.03 * Hh);
    const e = blank('chimney');
    e.polygon = [P(c.a, yb), P(c.b + 1, yb), P(c.b + 1, c.top), P(c.a, c.top)];
    e.material = chimneyMaterial(c.a, c.top, c.b, yb);
    elements.push(e);
  }
  for (const d of nms(dets.filter((x) => x.label === 'light'), 0.3, true)) {
    if (boxW(d) > 0.05 * (x1 - x0) / f) continue;
    const e = blank('light');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    elements.push(e);
  }

  // Stories from the height of the main wall compared with a door or garage door.
  const ref = garages[0] ? boxH(garages[0]) / 7.3 : doors[0] ? boxH(doors[0]) / 7 : null;
  const mainWall = wings.reduce((a, b) => (b.b - b.a > a.b - a.a ? b : a), wings[0]);
  const wallFt = ref && mainWall ? (groundG - mainWall.y) / f / ref : null;
  const stories = wallFt ? Math.max(1, Math.min(3, Math.round(wallFt / 10))) : 1;

  if (!openings.length) notes.push('No windows or doors were recognised — add them with the tools.');
  return {
    analysis: {
      houseFound: true,
      groundY: groundPhoto,
      stories,
      architecturalStyle: '',
      elements,
      notes: notes.join(' '),
    },
    debug: { w, h, scale: f, house, label: smooth, top: topFixed, eave: eaveS, groundY: groundG, span: [x0, x1], separation: accuracy, notes, openings: openings.map(G), topRaw: top, topReliable, veg, llr, contrast },
  };
}

/**
 * Eave height at the two ends of the house from its outline: going down a hip or
 * gable end the outline steps outwards along the roof edge until the eave corner,
 * then drops straight down the wall. Returns null for an end that has no sloped
 * roof edge (flat roofs, parapets) or can't be read.
 */
function sideEaves(house: Mask, x0: number, x1: number, yTop: number, groundG: number, Hh: number): { left: number | null; right: number | null } {
  const w = house.w;
  const yA = Math.max(0, Math.floor(yTop));
  const yB = Math.floor(groundG - 0.2 * Hh);
  if (yB - yA < 8) return { left: null, right: null };
  const n = yB - yA + 1;
  const L = new Float64Array(n).fill(NaN);
  const R = new Float64Array(n).fill(NaN);
  for (let y = yA; y <= yB; y++) {
    for (let x = x0; x <= x1; x++)
      if (house.data[y * w + x]) {
        L[y - yA] = x;
        break;
      }
    for (let x = x1; x >= x0; x--)
      if (house.data[y * w + x]) {
        R[y - yA] = x;
        break;
      }
  }
  const find = (P: Float64Array, outwardSign: number): number | null => {
    const o = medianFilter(Float64Array.from(P, (v) => v * outwardSign), 2);
    let max = -Infinity;
    for (let k = 0; k < n; k++) if (!isNaN(o[k]) && o[k] > max) max = o[k];
    if (!isFinite(max)) return null;
    let k0 = -1;
    for (let k = 0; k < n; k++)
      if (!isNaN(o[k]) && o[k] >= max - 1.5) {
        k0 = k;
        break;
      }
    if (k0 < 0) return null;
    const y = yA + k0;
    if (y - yA < 0.08 * Hh || y > groundG - 0.35 * Hh) return null;
    // The outline above the corner must lean inwards (a roof edge), not rise straight up (a wall).
    const d = Math.max(2, Math.round(Math.min(0.12 * Hh, k0)));
    const above = o[k0 - d];
    if (isNaN(above) || max - above < 0.35 * d) return null;
    return y;
  };
  return { left: find(L, -1), right: find(R, 1) };
}

/**
 * Contrast between the colour just above and just below each pixel (mean over `k`
 * rows each side), for rows lo..hi of the given columns. Normalised so the
 * strongest breaks inside the house score about 1.
 */
function verticalContrast(lab: Float32Array, w: number, h: number, k: number, x0: number, x1: number, lo: Int32Array, hi: Int32Array, top: Float64Array): Float32Array {
  const out = new Float32Array(w * h);
  const col = new Float64Array((h + 1) * 3);
  const vals: number[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) col[(y + 1) * 3 + c] = col[y * 3 + c] + lab[(y * w + x) * 3 + c];
    // Only compare pixels inside the house: the roofline itself (sky or trees against the roof) is not an eave.
    const t = Math.max(0, Math.ceil(top[x]) + 2);
    for (let y = Math.max(k, lo[x], t + 1); y <= Math.min(h - k, hi[x]); y++) {
      const ka = Math.min(k, y - t);
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const above = (col[y * 3 + c] - col[(y - ka) * 3 + c]) / ka;
        const below = (col[(y + k) * 3 + c] - col[y * 3 + c]) / k;
        const wgt = c === 0 ? 1 : 0.7;
        d += wgt * (above - below) * (above - below);
      }
      out[y * w + x] = Math.sqrt(d);
    }
  }
  // Favour breaks that continue sideways (eaves are long straight lines).
  const sm = new Float32Array(w * h);
  for (let x = x0; x <= x1; x++)
    for (let y = lo[x]; y <= hi[x]; y++) {
      let s = 0;
      let n = 0;
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        if (xx < x0 || xx > x1) continue;
        s += out[y * w + xx];
        n++;
      }
      sm[y * w + x] = s / n;
      vals.push(sm[y * w + x]);
    }
  vals.sort((a, b) => a - b);
  const ref = vals[Math.floor(vals.length * 0.97)] || 1;
  for (let i = 0; i < sm.length; i++) sm[i] = Math.min(1.5, sm[i] / ref);
  return sm;
}

/**
 * Cost of an eave at each pixel judged against the roof's own colour, sampled just under the
 * roofline (trusted columns, carried across the rest): an eave has roof-coloured pixels right
 * above it and something else right below. Lines inside the roof (hips, shadows, a chimney's
 * flashing) and inside the wall (window heads, a change of cladding) both score badly.
 */
function roofSideCost(
  lab: Float32Array,
  w: number,
  x0: number,
  x1: number,
  lo: Int32Array,
  hi: Int32Array,
  top: Float64Array,
  k: number,
  band: number,
  smoothR: number,
  trusted: (x: number) => boolean,
  usable: (i: number) => boolean,
): Float32Array | null {
  const ref: Float64Array[] = [0, 1, 2].map(() => new Float64Array(w).fill(NaN));
  let any = 0;
  for (let x = x0; x <= x1; x++) {
    if (!trusted(x)) continue;
    const s = [0, 0, 0];
    let n = 0;
    for (let y = Math.round(top[x]) + 2; y <= top[x] + 1 + band; y++) {
      const i = y * w + x;
      if (!usable(i)) continue;
      for (let c = 0; c < 3; c++) s[c] += lab[i * 3 + c];
      n++;
    }
    if (!n) continue;
    for (let c = 0; c < 3; c++) ref[c][x] = s[c] / n;
    any++;
  }
  if (any < 0.1 * (x1 - x0 + 1)) return null;
  for (let c = 0; c < 3; c++) {
    ref[c] = medianFilter(ref[c], smoothR);
    fillGaps(ref[c], x0, x1);
  }
  const TAU = 12;
  const out = new Float32Array(lab.length / 3);
  const dist = (sum: number[], n: number, x: number) => {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const v = sum[c] / n - ref[c][x];
      d += (c === 0 ? 1 : 0.7) * v * v;
    }
    return Math.sqrt(d);
  };
  for (let x = x0; x <= x1; x++) {
    const t = Math.ceil(top[x]) + 2;
    for (let y = Math.max(lo[x], t + 1); y <= hi[x]; y++) {
      const above = [0, 0, 0];
      const below = [0, 0, 0];
      let na = 0;
      let nb = 0;
      for (let yy = Math.max(t, y - k); yy < y; yy++, na++) for (let c = 0; c < 3; c++) above[c] += lab[(yy * w + x) * 3 + c];
      for (let yy = y; yy < y + k && yy * w + x < out.length; yy++, nb++) for (let c = 0; c < 3; c++) below[c] += lab[(yy * w + x) * 3 + c];
      if (!na || !nb) continue;
      out[y * w + x] = 0.5 * (Math.max(0, 1 - dist(below, nb, x) / TAU) + Math.min(1, dist(above, na, x) / TAU));
    }
  }
  return out;
}

/**
 * Best left-to-right eave line y(x) by dynamic programming. Each column scores the
 * colour break at y plus (with `llr`) how roof-like everything between the roofline
 * and y is and how wall-like the pixels below are; `slope` is charged per pixel of
 * gradual rise/fall and `jump` for a step where one wing meets another.
 */
function traceEave(
  c: Float32Array,
  llr: Float32Array | null,
  extra: Float32Array | null,
  top: Float64Array,
  w: number,
  x0: number,
  x1: number,
  lo: Int32Array,
  hi: Int32Array,
  pen: { slope: number; jump: number; region: number; prior: Float64Array; priorW: Float64Array },
): Float64Array {
  const cols = x1 - x0 + 1;
  const off = new Int32Array(cols + 1);
  for (let i = 0; i < cols; i++) off[i + 1] = off[i] + (hi[x0 + i] - lo[x0 + i] + 1);
  const D = new Float64Array(off[cols]);
  const from = new Int32Array(off[cols]);
  for (let i = 0; i < cols; i++) {
    const x = x0 + i;
    const n = hi[x] - lo[x] + 1;
    const unary = new Float64Array(n);
    {
      // Region term: roof-likeness above y (from the roofline) minus below y (down to hi).
      let above = 0;
      let total = 0;
      if (llr) for (let y = Math.max(0, Math.round(top[x])); y <= hi[x]; y++) total += llr[y * w + x];
      let yy = Math.max(0, Math.round(top[x]));
      for (let s = 0; s < n; s++) {
        const y = lo[x] + s;
        if (llr) for (; yy < y; yy++) above += llr[yy * w + x];
        const region = llr ? above - (total - above) : 0;
        const p = isNaN(pen.prior[x]) ? 0 : pen.priorW[x] * Math.abs(y - pen.prior[x]);
        unary[s] = -c[y * w + x] - Math.max(-3, Math.min(3, pen.region * region)) + p + (extra ? extra[y * w + x] : 0);
      }
    }
    if (i === 0) {
      for (let s = 0; s < n; s++) D[off[i] + s] = unary[s];
      continue;
    }
    const px = x - 1;
    const pn = hi[px] - lo[px] + 1;
    let bestAll = Infinity;
    let bestAllS = 0;
    for (let s = 0; s < pn; s++)
      if (D[off[i - 1] + s] < bestAll) {
        bestAll = D[off[i - 1] + s];
        bestAllS = s;
      }
    for (let s = 0; s < n; s++) {
      const y = lo[x] + s;
      let best = bestAll + pen.jump;
      let arg = lo[px] + bestAllS;
      for (let dy = -2; dy <= 2; dy++) {
        const py = y + dy;
        if (py < lo[px] || py > hi[px]) continue;
        const v = D[off[i - 1] + (py - lo[px])] + pen.slope * Math.abs(dy);
        if (v < best) {
          best = v;
          arg = py;
        }
      }
      D[off[i] + s] = best + unary[s];
      from[off[i] + s] = arg;
    }
  }
  const out = new Float64Array(w).fill(NaN);
  const last = cols - 1;
  let bs = 0;
  for (let s = 1; s < hi[x1] - lo[x1] + 1; s++) if (D[off[last] + s] < D[off[last] + bs]) bs = s;
  let y = lo[x1] + bs;
  for (let i = last; i >= 0; i--) {
    const x = x0 + i;
    out[x] = y;
    if (i > 0) y = from[off[i] + (y - lo[x])];
  }
  return out;
}

/**
 * Porch and garage roofs below the main eave: wide, short horizontal bands of
 * pixels that the roof model prefers over the wall model.
 */
function findLowerRoofs(c: {
  w: number;
  h: number;
  x0: number;
  x1: number;
  eave: Float64Array;
  groundG: number;
  Hh: number;
  isRoof: (i: number) => boolean;
}): { a: number; b: number; top: Float64Array; bottom: Float64Array; pixels: number[] }[] {
  const { w, h, x0, x1, eave, groundG, Hh } = c;
  const m = new Uint8Array(w * h);
  for (let x = x0; x <= x1; x++) {
    if (isNaN(eave[x])) continue;
    for (let y = Math.ceil(eave[x] + 0.04 * Hh); y < groundG - 0.06 * Hh; y++) if (c.isRoof(y * w + x)) m[y * w + x] = 1;
  }
  const cleaned = openMask(closeMask({ w, h, data: m }, 1), 1);
  const { labels, comps } = components(cleaned);
  const span = x1 - x0;
  const out: { a: number; b: number; top: Float64Array; bottom: Float64Array; pixels: number[] }[] = [];
  for (const comp of comps) {
    const bw = comp.x1 - comp.x0 + 1;
    const bh = comp.y1 - comp.y0 + 1;
    if (comp.area > 0.002 * w * h) autotraceDebug.log?.(`  band? x${comp.x0}-${comp.x1} y${comp.y0}-${comp.y1} w${bw} h${bh} fill${(comp.area / (bw * bh)).toFixed(2)} (span ${span}, Hh ${Hh.toFixed(0)})`);
    const minFill = bw > 0.3 * span ? 0.3 : 0.45;
    if (bw < 0.1 * span || bh < 0.02 * Hh || bh > 0.3 * Hh || bw < 2.5 * bh || comp.area < minFill * bw * bh) continue;
    if ((comp.y0 + comp.y1) / 2 > groundG - 0.12 * Hh) continue;
    const t = new Float64Array(w).fill(NaN);
    const bt = new Float64Array(w).fill(NaN);
    const pixels: number[] = [];
    for (let y = comp.y0; y <= comp.y1; y++)
      for (let x = comp.x0; x <= comp.x1; x++) {
        const i = y * w + x;
        if (labels[i] !== comp.label) continue;
        pixels.push(i);
        if (isNaN(t[x])) t[x] = y;
        bt[x] = y + 1;
      }
    const ts = medianFilter(t, 3);
    const bs = medianFilter(bt, 3);
    fillGaps(ts, comp.x0, comp.x1);
    fillGaps(bs, comp.x0, comp.x1);
    out.push({ a: comp.x0, b: comp.x1, top: ts, bottom: bs, pixels });
  }
  return out;
}

/** Wall cladding from colour and texture of the wall samples (features: L, a, b, texture across, texture along). */
function guessWallMaterial(feat: Float32Array, D: number, seeds: number[]): string {
  if (seeds.length < 30) return 'lap';
  const med = (c: number) => median(seeds.map((i) => feat[i * D + c]));
  const [L, a, b, tx, ty] = [med(0), med(1), med(2), med(3), med(4)];
  autotraceDebug.log?.(`wall L${L.toFixed(0)} a${a.toFixed(0)} b${b.toFixed(0)} tx${tx.toFixed(1)} ty${ty.toFixed(1)}`);
  const energy = tx + ty;
  const along = ty / Math.max(0.3, tx);
  // Brick: reddish and busy both ways (mortar joints). Stucco: smooth. Lap siding: lines along the wall.
  if (a > 7 && b < 2 * a + 2 && energy > 7 && along < 1.8) return 'brick';
  if (energy < 6.5 && along < 2.5) return 'stucco';
  return 'lap';
}

function guessRoofMaterial(g: GaussN): string {
  const [, a, b] = g.mean;
  return a > 10 && b > 12 ? 'tile' : 'shingle';
}
