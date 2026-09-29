/// <reference lib="webworker" />
// Runs the on-device auto-trace off the main thread: downloads the models once
// (kept in Cache Storage for later visits), then segments and detects.
import * as ort from 'onnxruntime-web/wasm';
import type { Rect } from './house';
import { MODELS, type ModelName } from './models';
import { autoTrace, type ModelRunner } from './pipeline';

export interface RunRequest {
  type: 'run';
  id: number;
  width: number;
  height: number;
  data: ArrayBuffer;
  wallHint: Rect | null;
  /** Absolute URL of the folder holding the .onnx files. */
  modelBase: string;
}

export type WorkerReply =
  | { type: 'progress'; id: number; message: string; fraction: number }
  | { type: 'result'; id: number; analysis: import('../shared/analysisSchema').Analysis; ms: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const CACHE = 'blueprint-engraver-models-v1';
ort.env.wasm.numThreads = ctx.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const sessions = new Map<ModelName, Promise<ort.InferenceSession>>();

async function download(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  try {
    const hit = await (await caches.open(CACHE)).match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    /* Cache Storage unavailable (private mode): just download. */
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the house-detection model (${res.status}).`);
  const parts: Uint8Array[] = [];
  let loaded = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      onBytes(loaded);
    }
  } else {
    parts.push(new Uint8Array(await res.arrayBuffer()));
    loaded = parts[0].length;
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  try {
    await (await caches.open(CACHE)).put(url, new Response(out, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    /* ignore */
  }
  return out;
}

function session(name: ModelName, base: string, onBytes: (n: number) => void): Promise<ort.InferenceSession> {
  let s = sessions.get(name);
  if (!s) {
    s = download(new URL(MODELS[name].file, base).href, onBytes).then((bytes) => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
    s.catch(() => sessions.delete(name));
    sessions.set(name, s);
  }
  return s;
}

ctx.onmessage = async (e: MessageEvent<RunRequest>) => {
  const req = e.data;
  if (req.type !== 'run') return;
  const post = (m: WorkerReply) => ctx.postMessage(m);
  const t0 = performance.now();
  try {
    // Download (first time only) with byte-level progress over all three models.
    const names: ModelName[] = ['seg', 'openings', 'extras'];
    const totalMb = names.reduce((s, n) => s + MODELS[n].mb, 0);
    const got: Record<string, number> = {};
    let cached = true;
    for (const n of names) {
      await session(n, req.modelBase, (bytes) => {
        cached = false;
        got[n] = bytes;
        const mb = Object.values(got).reduce((s, b) => s + b, 0) / 1e6;
        post({ type: 'progress', id: req.id, message: `Downloading the house-detection models (first time only) — ${Math.min(totalMb, mb).toFixed(0)} of ${totalMb.toFixed(0)} MB…`, fraction: Math.min(0.6, (0.6 * mb) / totalMb) });
      });
    }
    const runner: ModelRunner = {
      async run(name, input) {
        const s = await session(name, req.modelBase, () => undefined);
        const size = MODELS[name].size;
        const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
        const t = out[s.outputNames[0]];
        return { data: t.data as Float32Array | Uint8Array, dims: t.dims };
      },
    };
    const base = cached ? 0 : 0.6;
    const photo = { width: req.width, height: req.height, data: new Uint8ClampedArray(req.data) };
    const res = await autoTrace(photo, runner, {
      wallHint: req.wallHint,
      onProgress: (message, fraction) => post({ type: 'progress', id: req.id, message, fraction: base + (1 - base) * fraction }),
    });
    post({ type: 'result', id: req.id, analysis: res.analysis, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
