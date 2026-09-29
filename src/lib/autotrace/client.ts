import { applyH, type Mat3 } from '../geometry/homography';
import { loadImage } from '../image/imageUtils';
import type { Photo, Straighten } from '../model/types';
import type { Analysis } from '../shared/analysisSchema';
import type { Rect } from './house';
import type { RunRequest, WorkerReply } from './worker';

/** Longest side of the image handed to the models (they work at 640–800 px anyway). */
const MAX_SIDE = 1600;

let worker: Worker | null = null;
let nextId = 1;

export interface AutoTraceJob {
  analysis: Analysis;
  /** Analysis pixels per photo pixel. */
  scale: number;
  ms: number;
}

/** The main-wall rectangle the user marked while straightening, in rectified-photo pixels. */
export function wallHintFrom(st: Straighten | null): Rect | null {
  if (!st?.quad || !st.H || st.quad.length !== 4) return null;
  const pts = st.quad.map((p) => applyH(st.H as Mat3, p));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Trace the house in `photo` on this device. Downloads the models on first use. */
export async function autoTracePhoto(photo: Photo, wallHint: Rect | null, onProgress: (message: string, fraction: number) => void): Promise<AutoTraceJob> {
  const img = await loadImage(photo.dataUrl);
  const s = Math.min(1, MAX_SIDE / Math.max(photo.width, photo.height));
  const w = Math.max(1, Math.round(photo.width * s));
  const h = Math.max(1, Math.round(photo.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h);
  const data = g.getImageData(0, 0, w, h).data;

  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const wk = worker;
  const id = nextId++;
  const modelBase = new URL(`${import.meta.env.BASE_URL}models/`, document.baseURI).href;
  return new Promise<AutoTraceJob>((resolve, reject) => {
    const done = () => {
      wk.removeEventListener('message', onMessage);
      wk.removeEventListener('error', onError);
    };
    const onMessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.id !== id) return;
      if (m.type === 'progress') {
        onProgress(m.message, m.fraction);
        return;
      }
      done();
      if (m.type === 'result') resolve({ analysis: m.analysis, scale: s, ms: m.ms });
      else reject(new Error(m.message));
    };
    const onError = (e: ErrorEvent) => {
      done();
      wk.terminate();
      if (worker === wk) worker = null;
      reject(new Error(e.message || 'The auto-trace worker stopped unexpectedly.'));
    };
    wk.addEventListener('message', onMessage);
    wk.addEventListener('error', onError);
    const hint = wallHint ? { x0: wallHint.x0 * s, y0: wallHint.y0 * s, x1: wallHint.x1 * s, y1: wallHint.y1 * s } : null;
    const req: RunRequest = { type: 'run', id, width: w, height: h, data: data.buffer as ArrayBuffer, wallHint: hint, modelBase };
    wk.postMessage(req, [req.data]);
  });
}
