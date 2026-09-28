/** Gradient (Sobel) map of a photo, used to snap traced boxes onto real edges. */
export interface EdgeMap {
  w: number;
  h: number;
  /** Map pixels per photo pixel. */
  scale: number;
  /** |horizontal gradient| — strong on vertical edges. */
  gx: Float32Array;
  /** |vertical gradient| — strong on horizontal edges. */
  gy: Float32Array;
}

export function edgeMapFromGray(gray: Float32Array, w: number, h: number, scale = 1): EdgeMap {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1];
      const b = gray[i - w];
      const c = gray[i - w + 1];
      const d = gray[i - 1];
      const f = gray[i + 1];
      const g = gray[i + w - 1];
      const hh = gray[i + w];
      const k = gray[i + w + 1];
      gx[i] = Math.abs(c + 2 * f + k - (a + 2 * d + g));
      gy[i] = Math.abs(g + 2 * hh + k - (a + 2 * b + c));
    }
  }
  return { w, h, scale, gx, gy };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Mean edge strength along map column/row `p` (integer index) between `from` and `to`. */
function lineScore(m: EdgeMap, vertical: boolean, p: number, from: number, to: number): number {
  const a = Math.max(1, Math.round(Math.min(from, to)));
  const b = Math.min((vertical ? m.h : m.w) - 2, Math.round(Math.max(from, to)));
  if (p < 1 || p > (vertical ? m.w : m.h) - 2 || b <= a) return 0;
  let s = 0;
  for (let t = a; t <= b; t++) s += vertical ? m.gx[t * m.w + p] : m.gy[p * m.w + t];
  return s / (b - a + 1);
}

/**
 * Move each side of `box` (photo pixels) to the strongest parallel edge within a small
 * search window. A side only moves when the new edge is clearly stronger.
 */
export function snapBox(m: EdgeMap, box: Box, opts: { reach?: number; minGain?: number } = {}): Box {
  const s = m.scale;
  const x0 = box.x * s;
  const y0 = box.y * s;
  const x1 = (box.x + box.w) * s;
  const y1 = (box.y + box.h) * s;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const minGain = opts.minGain ?? 1.2;
  // Positions are continuous map coordinates; pixel i covers [i, i + 1).
  const best = (vertical: boolean, at: number, from: number, to: number, reach: number) => {
    const score = (i: number) => lineScore(m, vertical, i, from, to);
    const near = Math.round(at - 0.5);
    const here = score(near);
    // Prefer strong edges close to the current side: this is a fine-tune, not a search.
    let bi = near;
    let bs = -1;
    let bw = -1;
    for (let i = Math.floor(at - reach); i <= Math.ceil(at + reach); i++) {
      const v = score(i);
      const weighted = v * (1 - Math.abs(i + 0.5 - at) / (2 * reach + 2));
      if (weighted > bw) {
        bw = weighted;
        bs = v;
        bi = i;
      }
    }
    if (!(bs > here * minGain + 1e-6)) return at;
    // Sub-pixel peak (a step edge lights up the two pixels on either side of it).
    const sm = score(bi - 1);
    const sp = score(bi + 1);
    const den = sm - 2 * bs + sp;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (sm - sp) / (2 * den))) : 0;
    return bi + 0.5 + off;
  };
  const rx = Math.max(2, Math.round(opts.reach ?? bw * 0.06 + 2));
  const ry = Math.max(2, Math.round(opts.reach ?? bh * 0.06 + 2));
  // Sample the middle 70% of each side so corners and neighbours don't dominate.
  const nx0 = best(true, x0, y0 + bh * 0.15, y1 - bh * 0.15, rx);
  const nx1 = best(true, x1, y0 + bh * 0.15, y1 - bh * 0.15, rx);
  const ny0 = best(false, y0, x0 + bw * 0.15, x1 - bw * 0.15, ry);
  const ny1 = best(false, y1, x0 + bw * 0.15, x1 - bw * 0.15, ry);
  if (nx1 - nx0 < bw * 0.5 || ny1 - ny0 < bh * 0.5) return box;
  return { x: nx0 / s, y: ny0 / s, w: (nx1 - nx0) / s, h: (ny1 - ny0) / s };
}

const cache = new Map<string, Promise<EdgeMap>>();

/** Build (and cache) the edge map for a photo data URL in the browser. */
export function edgeMapForPhoto(dataUrl: string, maxSide = 1600): Promise<EdgeMap> {
  const hit = cache.get(dataUrl);
  if (hit) return hit;
  const job = new Promise<EdgeMap>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(3, Math.round(img.naturalWidth * scale));
      const h = Math.max(3, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const gray = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      resolve(edgeMapFromGray(gray, w, h, scale));
    };
    img.onerror = () => reject(new Error('Could not read the photo'));
    img.src = dataUrl;
  });
  cache.clear();
  cache.set(dataUrl, job);
  return job;
}
