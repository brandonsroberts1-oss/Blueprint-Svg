import type { Vec } from '../geometry/vec';
import type { Analysis, DetectedElement } from '../shared/analysisSchema';
import { type Gauss3, fitGauss, mahal2, nll, rgbaToLab } from './color';
import { type Detection, boxH, boxW, coverage, nms } from './decode';
import { type Mask, closeMask, columnProfile, componentMask, components, douglasPeucker, fillHoles, maskWhere, openMask } from './mask';
import { GROUND_CLASSES, HOUSE_CLASSES, SKY_CLASSES, VEG_CLASSES } from './models';
import { type Raster, resample } from './raster';

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
  let best = big[0];
  let bestScore = -1;
  for (const c of big) {
    const cx = (c.x0 + c.x1) / 2;
    let s = c.area * (1 - (0.6 * Math.abs(cx - w / 2)) / (w / 2));
    if (hint) s *= 1 + 3 * overlap(c, hint);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  const chosen = new Set([best.label]);
  const box = { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1 };
  // Pull in pieces of the same house split apart by trees in front of it.
  for (let pass = 0; pass < 4; pass++) {
    let merged = false;
    for (const c of big) {
      if (chosen.has(c.label)) continue;
      const vo = Math.min(c.y1, box.y1) - Math.max(c.y0, box.y0);
      if (vo < 0.4 * Math.min(c.y1 - c.y0, box.y1 - box.y0)) continue;
      const gap = c.x0 > box.x1 ? c.x0 - box.x1 : box.x0 > c.x1 ? box.x0 - c.x1 : 0;
      if (gap > 0.1 * w) continue;
      if (gap > 2) {
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
        if (v < 0.4 * n) continue;
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

  const topReliable = new Uint8Array(w);
  const tops: number[] = [];
  for (let x = x0; x <= x1; x++) {
    if (isNaN(top[x])) continue;
    tops.push(top[x]);
    const t = top[x];
    if (t <= 1) continue;
    let skyAbove = false;
    for (let y = Math.max(0, t - 3); y < t; y++) if (SKY_CLASSES.has(cls[y * w + x])) skyAbove = true;
    if (skyAbove) topReliable[x] = 1;
  }
  const roofTop = quantile(tops, 0.15);
  let Hh = groundG - roofTop;
  if (hint && Math.abs(hint.y1 - groundG) < 0.12 * Hh) {
    groundG = hint.y1;
    Hh = groundG - roofTop;
  }
  if (!(Hh > 0.05 * h)) return fail('Could not find where the house meets the ground.');

  // ---------------------------------------------------------------- openings in grid space
  const G = (d: Detection) => ({ x0: d.x0 * f, y0: d.y0 * f, x1: d.x1 * f, y1: d.y1 * f });
  const inHouse = (d: Detection) => {
    const cx = Math.round(((d.x0 + d.x1) / 2) * f);
    const cy = Math.round(((d.y0 + d.y1) / 2) * f);
    if (cx < x0 - 2 || cx > x1 + 2 || cy < roofTop - 2 || cy > groundG + 2) return false;
    return house.data[Math.min(h - 1, Math.max(0, cy)) * w + Math.min(w - 1, Math.max(0, cx))] === 1;
  };
  const dets = input.detections.filter(inHouse);
  const openings = dets.filter((d) => d.label === 'window' || d.label === 'door' || d.label === 'garage');

  // ---------------------------------------------------------------- roof / wall colour models
  const small = resample(input.photo, w, h);
  const lab = rgbaToLab(small.data, N);
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
  const contrast = verticalContrast(lab, w, h, bandK, x0, x1, lo, hi);
  for (let x = x0; x <= x1; x++) if (occluded[x]) for (let y = lo[x]; y <= hi[x]; y++) contrast[y * w + x] = 0;

  // Initial colour models: roof from the band just under the roofline, wall from around the openings.
  const ringSeeds: number[] = [];
  for (const d of openings) {
    const b = G(d);
    const m = Math.max(2, 0.3 * Math.min(b.x1 - b.x0, b.y1 - b.y0));
    for (let y = Math.max(0, Math.floor(b.y0 - m)); y < Math.min(h, Math.ceil(b.y1 + m)); y++)
      for (let x = Math.max(0, Math.floor(b.x0 - m)); x < Math.min(w, Math.ceil(b.x1 + m)); x++) {
        const i = y * w + x;
        if (usable(i) && y < groundG) ringSeeds.push(i);
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
  let wallModel = fitGauss(lab, wallSeeds);
  let roofModel: Gauss3 | null = null;
  {
    const band = Math.max(2, Math.round(0.025 * Hh));
    const cand: number[] = [];
    for (let x = x0; x <= x1; x++) {
      if (!topReliable[x]) continue;
      for (let y = Math.round(topFilled[x]) + 1; y <= topFilled[x] + band && y < groundG; y++) if (usable(y * w + x)) cand.push(y * w + x);
    }
    const distinct = wallModel ? cand.filter((i) => mahal2(wallModel!, lab, i) > 6) : cand;
    roofModel = fitGauss(lab, distinct.length >= Math.max(20, 0.25 * cand.length) ? distinct : cand);
  }

  // Alternate: trace the eave with the current models, then refit the models from the traced split.
  const llr = new Float32Array(N);
  let eave: Float64Array = new Float64Array(w).fill(NaN);
  let roofSeedsFinal: number[] = [];
  for (let iter = 0; iter < 4; iter++) {
    const useRegion = !!(roofModel && wallModel);
    if (useRegion) {
      for (let x = x0; x <= x1; x++)
        for (let y = Math.max(0, Math.round(topFilled[x])); y <= hi[x]; y++) {
          const i = y * w + x;
          llr[i] = usable(i) ? Math.max(-2, Math.min(2, 0.5 * (nll(wallModel!, lab, i) - nll(roofModel!, lab, i)))) : 0;
        }
    }
    eave = traceEave(contrast, useRegion ? llr : null, topFilled, w, x0, x1, lo, hi, { slope: 0.15, jump: 6, region: 1 / Math.max(2, 0.15 * Hh), thick: 0.8 / Hh });
    const roofSeeds: number[] = [];
    const nextWall: number[] = ringSeeds.filter((i) => Math.floor(i / w) > eave[i % w]);
    for (let x = x0; x <= x1; x++) {
      if (occluded[x] || isNaN(eave[x])) continue;
      // Roof samples stay near the roofline so a wrong dip can't teach the model that walls are roof.
      if (eave[x] - topFilled[x] >= 0.05 * Hh)
        for (let y = Math.round(topFilled[x]) + 2; y < Math.min(eave[x] - 1, topFilled[x] + 0.18 * Hh); y++) if (usable(y * w + x)) roofSeeds.push(y * w + x);
      for (let y = Math.round(eave[x]) + 2; y < Math.min(groundG - 1, eave[x] + 0.12 * Hh); y++) if (usable(y * w + x)) nextWall.push(y * w + x);
    }
    const rm = roofSeeds.length >= 40 ? fitGauss(lab, roofSeeds) : null;
    const wm = nextWall.length >= 40 ? fitGauss(lab, nextWall) : wallModel;
    if (!rm || !wm) break;
    roofModel = rm;
    wallModel = wm;
    wallSeeds = nextWall;
    roofSeedsFinal = roofSeeds;
  }
  // Can colour tell them apart? Balanced accuracy of the two models on their own samples.
  let accuracy = 0;
  if (roofModel && wallModel && roofSeedsFinal.length && wallSeeds.length) {
    const hit = (idx: number[], roof: boolean) => {
      let n = 0;
      const step = Math.max(1, Math.floor(idx.length / 3000));
      let m = 0;
      for (let k = 0; k < idx.length; k += step, m++) if (nll(roofModel!, lab, idx[k]) < nll(wallModel!, lab, idx[k]) === roof) n++;
      return n / Math.max(1, m);
    };
    accuracy = (hit(roofSeedsFinal, true) + hit(wallSeeds, false)) / 2;
  }
  const colourOk = accuracy >= 0.8;

  // ---------------------------------------------------------------- labels: roof above the eave, lower roofs by colour
  const smooth = new Uint8Array(N);
  const minRun = Math.max(2, Math.round(0.045 * Hh));
  const lowRoof: { x: number; y0: number; y1: number }[] = [];
  for (let x = x0; x <= x1; x++) {
    if (isNaN(eave[x])) continue;
    for (let y = Math.max(0, Math.round(topFilled[x])); y < Math.min(h, groundG); y++) {
      const i = y * w + x;
      if (!house.data[i] || veg.data[i]) continue;
      if (y < eave[x]) smooth[i] = 1;
      else if (colourOk && !inOpening[i]) smooth[i] = nll(roofModel!, lab, i) + 1 < nll(wallModel!, lab, i) ? 1 : 2;
      else smooth[i] = 2;
    }
  }
  if (colourOk) {
    // Clean up speckle below the eave with a 5×5 majority vote, then collect long roof runs.
    const lab2 = majority(smooth, w, h, 2);
    for (let x = x0; x <= x1; x++) {
      if (isNaN(eave[x]) || occluded[x]) continue;
      let run0 = -1;
      for (let y = Math.round(eave[x]) + 1; y <= Math.round(groundG - 0.08 * Hh); y++) {
        const isRoof = y < groundG - 0.08 * Hh && lab2[y * w + x] === 1;
        if (isRoof && run0 < 0) run0 = y;
        if (!isRoof && run0 >= 0) {
          if (y - run0 >= minRun && run0 > eave[x] + 0.06 * Hh) lowRoof.push({ x, y0: run0, y1: y });
          run0 = -1;
        }
      }
    }
    for (let i = 0; i < N; i++) if (smooth[i]) smooth[i] = lab2[i] || smooth[i];
  }
  const dip = Math.max(2, Math.round(0.05 * (x1 - x0)));
  const spike = Math.max(1, Math.round(0.015 * (x1 - x0)));
  const eaveS = medianFilter(eave, 2);
  fillGaps(eaveS, x0, x1);
  profileMorph(eaveS, x0, x1, dip, 'open');
  profileMorph(eaveS, x0, x1, spike, 'close');
  const topS = medianFilter(top, 1);
  // Where trees hide the roofline, carry the neighbouring roofline across.
  const topFixed = new Float64Array(w).fill(NaN);
  for (let x = x0; x <= x1; x++) if (topReliable[x] || isNaN(topS[x]) === false) topFixed[x] = topReliable[x] ? topS[x] : NaN;
  fillGaps(topFixed, x0, x1);
  for (let x = x0; x <= x1; x++) if (!isNaN(topS[x]) && !topReliable[x] && topS[x] < topFixed[x]) topFixed[x] = topS[x];

  // ---------------------------------------------------------------- wall tops, gables, roofs
  const epsE = Math.max(1.5, 0.02 * Hh);
  const E = profilePolyline(eaveS, x0, x1, epsE);
  const minPeak = 0.07 * Hh;
  const gables: { a: number; b: number; base: number }[] = [];
  // A gable is a stretch where the wall top rises and falls again (the wall reaches up under the rakes).
  for (let i = 0; i < E.length - 1; i++) {
    if (E[i + 1].y >= E[i].y - minPeak * 0.5) continue; // not rising
    let j = i + 1;
    while (j < E.length - 1 && E[j + 1].y <= E[j].y + 0.5) j++; // climb / apex
    let k = j;
    while (k < E.length - 1 && E[k + 1].y > E[k].y + 0.5) k++; // descend
    const base = Math.max(E[i].y, E[k].y);
    const apex = Math.min(...E.slice(i, k + 1).map((p) => p.y));
    if (k > j && base - apex >= minPeak && E[k].x - E[i].x >= 0.06 * (x1 - x0)) gables.push({ a: E[i].x, b: E[k].x, base });
    i = k - 1;
  }
  const wallTop = new Float64Array(w).fill(NaN);
  for (let x = x0; x <= x1; x++) wallTop[x] = eaveS[x];
  for (const g of gables) for (let x = Math.ceil(g.a); x <= Math.floor(g.b); x++) wallTop[x] = g.base;
  // Wings: runs of columns whose wall top stays level.
  const tol = Math.max(2, 0.05 * Hh);
  const wings: { a: number; b: number; y: number }[] = [];
  let start = x0;
  for (let x = x0 + 1; x <= x1 + 1; x++) {
    const run = [];
    for (let k = start; k < x; k++) run.push(wallTop[k]);
    const level = median(run);
    if (x <= x1 && Math.abs(wallTop[x] - level) <= tol) continue;
    wings.push({ a: start, b: x - 1, y: quantile(run, 0.5) });
    start = x;
  }
  // Fold tiny wings into the neighbour with the closest level.
  for (let k = 0; k < wings.length; k++) {
    if (wings.length > 1 && wings[k].b - wings[k].a < 0.05 * (x1 - x0)) {
      const prev = wings[k - 1];
      const next = wings[k + 1];
      const target = !prev ? next : !next ? prev : Math.abs(prev.y - wings[k].y) <= Math.abs(next.y - wings[k].y) ? prev : next;
      target.a = Math.min(target.a, wings[k].a);
      target.b = Math.max(target.b, wings[k].b);
      wings.splice(k, 1);
      k = -1;
    }
  }
  for (let k = 1; k < wings.length; k++)
    if (Math.abs(wings[k].y - wings[k - 1].y) <= tol) {
      wings[k - 1].b = wings[k].b;
      wings[k - 1].y = Math.min(wings[k - 1].y, wings[k].y);
      wings.splice(k, 1);
      k--;
    }

  const P = (x: number, y: number): Vec => ({ x: x / f, y: y / f });
  const elements: DetectedElement[] = [];
  const wallMaterial = guessWallMaterial(lab, small, wallSeeds, w);
  const roofMaterial = roofModel ? guessRoofMaterial(roofModel) : 'shingle';

  for (const wg of wings) {
    const top0 = Math.min(wg.y, groundG - 0.2 * Hh);
    const e = blank('wall');
    e.polygon = [P(wg.a, groundG), P(wg.b + 1, groundG), P(wg.b + 1, top0), P(wg.a, top0)];
    e.material = wallMaterial;
    e.description = 'Wall (auto-traced)';
    elements.push(e);
  }

  // Roofs: wherever the roof band between the roofline and the wall top is thick enough.
  const minRoof = Math.max(2, 0.035 * Hh);
  const inGable = (x: number) => gables.some((g) => x >= g.a && x <= g.b);
  let rs = -1;
  const roofSpans: [number, number][] = [];
  for (let x = x0; x <= x1 + 1; x++) {
    const thick = x <= x1 && !inGable(x) && !isNaN(topFixed[x]) && !isNaN(eaveS[x]) && eaveS[x] - topFixed[x] >= minRoof;
    if (thick && rs < 0) rs = x;
    if (!thick && rs >= 0) {
      if (x - rs >= Math.max(3, 0.03 * (x1 - x0))) roofSpans.push([rs, x - 1]);
      rs = -1;
    }
  }
  const epsT = Math.max(1.2, 0.012 * Hh);
  for (const [a, b] of roofSpans) {
    const T = profilePolyline(topFixed, a, b, epsT, 0.08);
    const B = profilePolyline(eaveS, a, b, epsE);
    if (T.length < 2 || B.length < 2) continue;
    const e = blank('roof');
    e.polygon = [...T.map((p) => P(p.x, p.y)), ...[...B].reverse().map((p) => P(p.x, p.y))];
    if (b === x1) e.polygon.splice(T.length - 1, 1, P(x1 + 1, T[T.length - 1].y));
    e.material = roofMaterial;
    e.description = 'Roof (auto-traced)';
    elements.push(e);
  }

  for (const g of gables) {
    const T = profilePolyline(topFixed, Math.round(g.a), Math.round(g.b), epsT, 0.06).filter((p) => p.y < g.base - 1);
    if (T.length < 1) continue;
    const e = blank('gable');
    e.polygon = [P(g.a, g.base), ...T.map((p) => P(p.x, p.y)), P(g.b, g.base)];
    e.material = wallMaterial;
    e.description = 'Gable (auto-traced)';
    elements.push(e);
  }

  // Lower roofs in front of the walls (porches, garage roofs).
  lowRoof.sort((p, q) => p.x - q.x);
  const groups: { x: number; y0: number; y1: number }[][] = [];
  for (const r of lowRoof) {
    const g = groups.find((gr) => {
      const l = gr[gr.length - 1];
      return r.x - l.x <= 2 && Math.min(r.y1, l.y1) - Math.max(r.y0, l.y0) > 0;
    });
    if (g) g.push(r);
    else groups.push([r]);
  }
  for (const g of groups) {
    if (g.length < 0.06 * (x1 - x0)) continue;
    const ys0 = median(g.map((r) => r.y0));
    const ys1 = median(g.map((r) => r.y1));
    const e = blank('roof');
    e.polygon = [P(g[0].x, ys1), P(g[g.length - 1].x + 1, ys1), P(g[g.length - 1].x + 1, ys0), P(g[0].x, ys0)];
    e.material = roofMaterial;
    e.description = 'Lower roof (auto-traced)';
    elements.push(e);
  }

  // ---------------------------------------------------------------- openings and fixtures
  const groundPhoto = groundG / f;
  const HhPhoto = Hh / f;
  const nearGround = (d: Detection, tolFrac: number) => Math.abs(d.y1 - groundPhoto) <= tolFrac * HhPhoto;
  const garages = nms(dets.filter((d) => d.label === 'garage' && boxW(d) > boxH(d) * 0.9 && nearGround(d, 0.15)), 0.3, true);
  const doors = nms(
    dets.filter((d) => d.label === 'door' && !garages.some((g) => coverage(d, g) > 0.4)),
    0.3,
    true,
  );
  const windows = nms(
    dets.filter((d) => d.label === 'window' && !garages.some((g) => coverage(d, g) > 0.4) && !doors.some((o) => coverage(d, o) > 0.6)),
    0.3,
    true,
  );
  for (const d of garages) {
    const e = blank('garage');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: Math.max(d.y1, groundPhoto) };
    e.garageStyle = 'raised-panel';
    e.garageSections = 4;
    e.description = 'Garage door (auto-traced)';
    elements.push(e);
  }
  for (const d of doors) {
    const e = blank(nearGround(d, 0.12) ? 'door' : 'window');
    e.box = { x0: d.x0, y0: d.y0, x1: d.x1, y1: e.kind === 'door' ? Math.max(d.y1, groundPhoto - 0.01 * HhPhoto) : d.y1 };
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
  for (const d of nms(dets.filter((x) => x.label === 'chimney' && x.y0 * f < roofTop + 0.4 * Hh), 0.3, true)) {
    const e = blank('chimney');
    e.polygon = [P(d.x0 * f, d.y1 * f), P(d.x1 * f, d.y1 * f), P(d.x1 * f, d.y0 * f), P(d.x0 * f, d.y0 * f)];
    e.material = 'stucco';
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

  if (!colourOk) notes.push('The roof and walls are similar in colour, so lower roofs (porches) may be missing.');
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
    debug: { w, h, scale: f, house, label: smooth, top: topFixed, eave: eaveS, groundY: groundG, span: [x0, x1], separation: accuracy, notes },
  };
}

/**
 * Contrast between the colour just above and just below each pixel (mean over `k`
 * rows each side), for rows lo..hi of the given columns. Normalised so the
 * strongest breaks inside the house score about 1.
 */
function verticalContrast(lab: Float32Array, w: number, h: number, k: number, x0: number, x1: number, lo: Int32Array, hi: Int32Array): Float32Array {
  const out = new Float32Array(w * h);
  const col = new Float64Array((h + 1) * 3);
  const vals: number[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) col[(y + 1) * 3 + c] = col[y * 3 + c] + lab[(y * w + x) * 3 + c];
    for (let y = Math.max(k, lo[x]); y <= Math.min(h - k, hi[x]); y++) {
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const above = (col[y * 3 + c] - col[(y - k) * 3 + c]) / k;
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
 * Best left-to-right eave line y(x) by dynamic programming. Each column scores the
 * colour break at y plus (with `llr`) how roof-like everything between the roofline
 * and y is and how wall-like the pixels below are; `slope` is charged per pixel of
 * gradual rise/fall and `jump` for a step where one wing meets another.
 */
function traceEave(
  c: Float32Array,
  llr: Float32Array | null,
  top: Float64Array,
  w: number,
  x0: number,
  x1: number,
  lo: Int32Array,
  hi: Int32Array,
  pen: { slope: number; jump: number; region: number; thick: number },
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
        // A mild preference for thin roofs: flat-roofed and gable-fronted wings show little roof.
        unary[s] = -c[y * w + x] - Math.max(-3, Math.min(3, pen.region * region)) + pen.thick * (y - top[x]);
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

/** 5×5 (r = 2) majority vote between labels 1 and 2 (0 = ignore). */
function majority(label: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!label[i]) continue;
      let a = 0;
      let b = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const l = label[yy * w + xx];
          if (l === 1) a++;
          else if (l === 2) b++;
        }
      }
      out[i] = a > b ? 1 : 2;
    }
  return out;
}

/** Wall cladding from colour and texture of the wall samples. */
function guessWallMaterial(lab: Float32Array, img: Raster, seeds: number[], w: number): string {
  if (seeds.length < 30) return 'lap';
  let gx = 0;
  let gy = 0;
  let n = 0;
  let a = 0;
  let b = 0;
  let L = 0;
  for (const i of seeds) {
    const x = i % w;
    if (x < 1 || x >= w - 1 || i - w < 0 || i + w >= img.width * img.height) continue;
    gx += Math.abs(lab[(i + 1) * 3] - lab[(i - 1) * 3]);
    gy += Math.abs(lab[(i + w) * 3] - lab[(i - w) * 3]);
    L += lab[i * 3];
    a += lab[i * 3 + 1];
    b += lab[i * 3 + 2];
    n++;
  }
  if (!n) return 'lap';
  gx /= n;
  gy /= n;
  L /= n;
  a /= n;
  b /= n;
  const energy = gx + gy;
  if (energy < 5) return 'stucco';
  if (gy > 1.5 * gx && energy < 18) return 'lap';
  if (energy > 16 && a > 8) return 'brick';
  if (energy > 14) return 'stone';
  return b > 12 && L > 55 ? 'stucco' : 'lap';
}

function guessRoofMaterial(g: Gauss3): string {
  const [, a, b] = g.mean;
  return a > 10 && b > 12 ? 'tile' : 'shingle';
}
