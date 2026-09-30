/** Plain RGBA pixel buffer, usable in the browser, in a worker and in Node. */
export interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
}

/** Bilinear resample of a region of `src` (defaults to the whole image) to `w` × `h`. */
export function resample(src: Raster, w: number, h: number, region?: { x: number; y: number; w: number; h: number }): Raster {
  const r = region ?? { x: 0, y: 0, w: src.width, h: src.height };
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = r.w / w;
  const sy = r.h / h;
  const W = src.width;
  const H = src.height;
  const d = src.data;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(H - 1, Math.max(0, r.y + (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(H - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(W - 1, Math.max(0, r.x + (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(W - 1, x0 + 1);
      const tx = fx - x0;
      const a = (y0 * W + x0) * 4;
      const b = (y0 * W + x1) * 4;
      const c = (y1 * W + x0) * 4;
      const e = (y1 * W + x1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = d[a + k] + (d[b + k] - d[a + k]) * tx;
        const bot = d[c + k] + (d[e + k] - d[c + k]) * tx;
        out[o + k] = top + (bot - top) * ty;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Where a letterboxed image sits inside the model input. */
export interface Letterbox {
  /** Model input size in pixels. */
  w: number;
  h: number;
  /** Model-input pixels per source pixel. */
  scale: number;
  padX: number;
  padY: number;
  /** Source region that was fitted (source pixels). */
  region: { x: number; y: number; w: number; h: number };
}

/**
 * Fit a region of `src` into a `size` × `size` square, or a `{ w, h }` input (grey padding,
 * like YOLO's LetterBox), and return a normalised CHW float tensor.
 */
export function letterbox(src: Raster, size: number | { w: number; h: number }, region?: { x: number; y: number; w: number; h: number }): { tensor: Float32Array; box: Letterbox } {
  const r = region ?? { x: 0, y: 0, w: src.width, h: src.height };
  const W = typeof size === 'number' ? size : size.w;
  const H = typeof size === 'number' ? size : size.h;
  const scale = Math.min(W / r.w, H / r.h);
  const nw = Math.max(1, Math.min(W, Math.round(r.w * scale)));
  const nh = Math.max(1, Math.min(H, Math.round(r.h * scale)));
  const padX = Math.floor((W - nw) / 2);
  const padY = Math.floor((H - nh) / 2);
  const img = resample(src, nw, nh, r);
  const plane = W * H;
  const t = new Float32Array(3 * plane).fill(114 / 255);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = (y * nw + x) * 4;
      const o = (y + padY) * W + (x + padX);
      t[o] = img.data[i] / 255;
      t[plane + o] = img.data[i + 1] / 255;
      t[2 * plane + o] = img.data[i + 2] / 255;
    }
  }
  return { tensor: t, box: { w: W, h: H, scale, padX, padY, region: r } };
}

/**
 * Model input for a region of the given aspect ratio: about as many pixels as the
 * model's square `size`, reshaped to the region (multiples of 32), and never more
 * than `maxUpscale` times the region's own resolution.
 */
export function inputSize(size: number, region: { w: number; h: number }, maxUpscale = 2): { w: number; h: number } {
  const aspect = Math.max(0.25, Math.min(4, region.w / region.h));
  const k = Math.min(1, (maxUpscale * Math.sqrt(region.w * region.h)) / size);
  const snap = (v: number) => Math.max(64, Math.round(v / 32) * 32);
  return { w: snap(size * k * Math.sqrt(aspect)), h: snap((size * k) / Math.sqrt(aspect)) };
}

/** Model-input coordinates back to source pixels. */
export function fromLetterbox(b: Letterbox, x: number, y: number): { x: number; y: number } {
  return { x: b.region.x + (x - b.padX) / b.scale, y: b.region.y + (y - b.padY) / b.scale };
}
