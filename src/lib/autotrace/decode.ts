import { type Letterbox, fromLetterbox } from './raster';

export interface Detection {
  /** Source-image pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
  /** Label from the model's class list. */
  label: string;
}

export const boxW = (d: { x0: number; x1: number }) => d.x1 - d.x0;
export const boxH = (d: { y0: number; y1: number }) => d.y1 - d.y0;

export function iou(a: Detection, b: Detection): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (boxW(a) * boxH(a) + boxW(b) * boxH(b) - inter);
}

/** Fraction of `a` covered by `b`. */
export function coverage(a: Detection, b: Detection): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1e-9, boxW(a) * boxH(a));
}

/** Greedy non-maximum suppression (per label unless `agnostic`). */
export function nms(dets: Detection[], iouThr = 0.5, agnostic = false): Detection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.some((k) => (agnostic || k.label === d.label) && iou(k, d) > iouThr)) continue;
    keep.push(d);
  }
  return keep;
}

/**
 * Decode a YOLO-style head output of shape [1, 4 + classes (+ extra), anchors]:
 * rows 0-3 are box centre/size in model-input pixels, then one sigmoid score per class.
 */
export function decodeYolo(
  out: Float32Array,
  dims: readonly number[],
  labels: readonly string[],
  box: Letterbox,
  opts: { conf?: number; iou?: number; minConf?: Partial<Record<string, number>> } = {},
): Detection[] {
  const rows = dims[1];
  const n = dims[2];
  const nc = labels.length;
  if (rows < 4 + nc) throw new Error(`Unexpected model output ${dims.join('x')}`);
  const base = opts.conf ?? 0.1;
  const found: Detection[] = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bs = 0;
    for (let c = 0; c < nc; c++) {
      const s = out[(4 + c) * n + i];
      if (s > bs) {
        bs = s;
        best = c;
      }
    }
    if (best < 0) continue;
    const label = labels[best];
    if (bs < (opts.minConf?.[label] ?? base)) continue;
    const cx = out[i];
    const cy = out[n + i];
    const w = out[2 * n + i];
    const h = out[3 * n + i];
    const a = fromLetterbox(box, cx - w / 2, cy - h / 2);
    const b = fromLetterbox(box, cx + w / 2, cy + h / 2);
    found.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, score: bs, label });
  }
  return nms(found, opts.iou ?? 0.5);
}
