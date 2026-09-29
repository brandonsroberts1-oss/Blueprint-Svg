import type { Analysis } from '../shared/analysisSchema';
import { type Detection, decodeYolo } from './decode';
import { type HouseParseDebug, type Rect, type SegGrid, parseHouse } from './house';
import { components, maskWhere, openMask } from './mask';
import { HOUSE_CLASSES, MODELS, type ModelName } from './models';
import { type Raster, letterbox } from './raster';

export interface ModelOutput {
  data: Float32Array | Uint8Array | Int32Array | BigInt64Array;
  dims: readonly number[];
}

/** Runs one of the on-device models on a CHW float tensor. */
export interface ModelRunner {
  run(name: ModelName, input: Float32Array): Promise<ModelOutput>;
}

export interface AutoTraceOptions {
  /** Main-wall rectangle from the straighten step (photo pixels). */
  wallHint?: Rect | null;
  onProgress?: (message: string, fraction: number) => void;
}

export interface AutoTraceResult {
  analysis: Analysis;
  detections: Detection[];
  seg: SegGrid;
  debug: HouseParseDebug | null;
}

/** Map both detectors' vocabularies onto the parser's labels, with per-label thresholds. */
const OPENINGS_MAP: Record<string, [string, number]> = {
  window: ['window', 0.2],
  door: ['door', 0.2],
  lamp: ['light', 0.25],
  porch: ['porch', 0.3],
  stairs: ['stairs', 0.3],
};
const EXTRAS_MAP: Record<string, [string, number]> = {
  'garage door': ['garage', 0.2],
  lamp: ['light', 0.3],
  'front door': ['door', 0.3],
  chimney: ['chimney', 0.3],
  column: ['column', 0.35],
};

function toInt(v: number | bigint) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Crop the class map to the letterboxed photo area. */
function segGrid(out: ModelOutput, box: ReturnType<typeof letterbox>['box']): SegGrid {
  const size = box.size;
  const w = Math.round(box.region.w * box.scale);
  const h = Math.round(box.region.h * box.scale);
  const cls = new Uint8Array(w * h);
  const d = out.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = toInt(d[(y + box.padY) * size + (x + box.padX)] as number | bigint);
      cls[y * w + x] = v;
    }
  return { w, h, cls, scale: box.scale };
}

/** Rough photo-pixel box around the main house, for running the detectors at a useful scale. */
function houseCrop(seg: SegGrid, photo: Raster): { x: number; y: number; w: number; h: number } {
  const m = openMask(
    maskWhere(seg.w, seg.h, (i) => HOUSE_CLASSES.has(seg.cls[i])),
    1,
  );
  const { comps } = components(m);
  let best = null as null | (typeof comps)[number];
  let bs = -1;
  for (const c of comps) {
    const s = c.area * (1 - (0.6 * Math.abs((c.x0 + c.x1) / 2 - seg.w / 2)) / (seg.w / 2));
    if (s > bs) {
      bs = s;
      best = c;
    }
  }
  if (!best || best.area < 0.01 * seg.w * seg.h) return { x: 0, y: 0, w: photo.width, h: photo.height };
  // Include neighbouring house pieces at the same height (split by trees).
  let { x0, y0, x1, y1 } = best;
  for (const c of comps) {
    if (c.area < 0.004 * seg.w * seg.h) continue;
    const vo = Math.min(c.y1, y1) - Math.max(c.y0, y0);
    if (vo > 0.4 * Math.min(c.y1 - c.y0, y1 - y0) && (c.x0 - x1 < 0.1 * seg.w || x0 - c.x1 < 0.1 * seg.w)) {
      x0 = Math.min(x0, c.x0);
      x1 = Math.max(x1, c.x1);
      y0 = Math.min(y0, c.y0);
      y1 = Math.max(y1, c.y1);
    }
  }
  const s = seg.scale;
  const mx = 0.06 * (x1 - x0) + 4;
  const my = 0.08 * (y1 - y0) + 4;
  const X0 = Math.max(0, (x0 - mx) / s);
  const Y0 = Math.max(0, (y0 - my) / s);
  const X1 = Math.min(photo.width, (x1 + 1 + mx) / s);
  const Y1 = Math.min(photo.height, (y1 + 1 + my) / s);
  return { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
}

function mapLabels(dets: Detection[], map: Record<string, [string, number]>): Detection[] {
  const out: Detection[] = [];
  for (const d of dets) {
    const m = map[d.label];
    if (m && d.score >= m[1]) out.push({ ...d, label: m[0] });
  }
  return out;
}

/** Run segmentation + detectors on a (straightened) photo and parse the house. */
export async function autoTrace(photo: Raster, runner: ModelRunner, opts: AutoTraceOptions = {}): Promise<AutoTraceResult> {
  const progress = opts.onProgress ?? (() => undefined);

  progress('Finding the house…', 0.05);
  const segIn = letterbox(photo, MODELS.seg.size);
  const seg = segGrid(await runner.run('seg', segIn.tensor), segIn.box);

  const crop = houseCrop(seg, photo);
  progress('Finding windows and doors…', 0.35);
  const opIn = letterbox(photo, MODELS.openings.size, crop);
  const op = await runner.run('openings', opIn.tensor);
  const openings = mapLabels(decodeYolo(op.data as Float32Array, op.dims, MODELS.openings.labels, opIn.box, { conf: 0.15 }), OPENINGS_MAP);

  progress('Finding garage doors and lights…', 0.65);
  const exIn = letterbox(photo, MODELS.extras.size, crop);
  const ex = await runner.run('extras', exIn.tensor);
  const extras = mapLabels(decodeYolo(ex.data as Float32Array, ex.dims, MODELS.extras.labels, exIn.box, { conf: 0.15 }), EXTRAS_MAP);

  progress('Tracing walls and roofs…', 0.9);
  const detections = [...openings, ...extras];
  const { analysis, debug } = parseHouse({ photo, seg, detections, wallHint: opts.wallHint ?? null });
  progress('Done', 1);
  return { analysis, detections, seg, debug };
}
