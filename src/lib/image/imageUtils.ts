import { type Mat3, applyH, hW, homographyFromPoints, invertH, multiplyH } from '../geometry/homography';
import type { Vec } from '../geometry/vec';
import type { Photo } from '../model/types';

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

function canvasOf(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Load a user photo, downscaled so its long side is at most `maxSide` pixels. */
export async function importPhoto(file: File, maxSide = 3000): Promise<Photo> {
  const url = await readFileAsDataUrl(file);
  const img = await loadImage(url);
  return resizeImage(img, maxSide);
}

export function resizeImage(img: HTMLImageElement | HTMLCanvasElement, maxSide: number, quality = 0.92): Photo {
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = canvasOf(w * s, h * s);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height };
}

export interface WarpResult {
  photo: Photo;
  /** Maps original-photo pixels to rectified-photo pixels. */
  H: Mat3;
}

/**
 * Rectify `img` so that `quad` (tl, tr, br, bl on the photo) becomes a rectangle with
 * the given real aspect ratio (width / height). The whole photo is kept (within
 * reasonable bounds) so roofs above the quad survive.
 */
export function warpToRectangle(img: HTMLImageElement, quad: Vec[], aspect: number, maxOut = 2400): WarpResult | null {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const [tl, tr, br, bl] = quad;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const rectW = (top + bottom) / 2;
  const rectH = rectW / aspect;
  const H0 = homographyFromPoints(quad, [
    { x: 0, y: 0 },
    { x: rectW, y: 0 },
    { x: rectW, y: rectH },
    { x: 0, y: rectH },
  ]);
  if (!H0) return null;

  // Bounds of the transformed photo, keeping only parts that are not stretched
  // excessively (points approaching the horizon blow up in a perspective warp).
  const center = { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 };
  const wc = hW(H0, center);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const N = 48;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = { x: (i / N) * W, y: (j / N) * H };
      const w = hW(H0, p);
      if (!(w / wc >= 0.55)) continue;
      const q = applyH(H0, p);
      x0 = Math.min(x0, q.x);
      y0 = Math.min(y0, q.y);
      x1 = Math.max(x1, q.x);
      y1 = Math.max(y1, q.y);
    }
  }
  if (!isFinite(x0)) return null;
  x0 = Math.max(x0, -5 * rectW);
  x1 = Math.min(x1, 6 * rectW);
  y0 = Math.max(y0, -6 * rectH);
  y1 = Math.min(y1, 6 * rectH);
  const bw = x1 - x0;
  const bh = y1 - y0;
  const s = Math.min(maxOut / Math.max(bw, bh), 1.5);
  const outW = Math.round(bw * s);
  const outH = Math.round(bh * s);
  const T: Mat3 = [s, 0, -x0 * s, 0, s, -y0 * s, 0, 0, 1];
  const Hf = multiplyH(T, H0);
  const inv = invertH(Hf);
  if (!inv) return null;

  const src = canvasOf(W, H);
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(img, 0, 0);
  const sdata = sctx.getImageData(0, 0, W, H).data;
  const out = canvasOf(outW, outH);
  const octx = out.getContext('2d')!;
  const odata = octx.createImageData(outW, outH);
  const o = odata.data;
  const [a, b, c, d, e, f, g, h, i] = inv;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const px = u + 0.5;
      const py = v + 0.5;
      const w = g * px + h * py + i;
      const sx = (a * px + b * py + c) / w - 0.5;
      const sy = (d * px + e * py + f) / w - 0.5;
      const k = (v * outW + u) * 4;
      if (w <= 0 || sx < 0 || sy < 0 || sx > W - 1 || sy > H - 1) {
        o[k] = 245;
        o[k + 1] = 245;
        o[k + 2] = 245;
        o[k + 3] = 255;
        continue;
      }
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const i00 = (iy * W + ix) * 4;
      const i10 = i00 + (ix + 1 < W ? 4 : 0);
      const i01 = i00 + (iy + 1 < H ? W * 4 : 0);
      const i11 = i01 + (ix + 1 < W ? 4 : 0);
      for (let ch = 0; ch < 3; ch++) {
        const top = sdata[i00 + ch] * (1 - fx) + sdata[i10 + ch] * fx;
        const bot = sdata[i01 + ch] * (1 - fx) + sdata[i11 + ch] * fx;
        o[k + ch] = top * (1 - fy) + bot * fy;
      }
      o[k + 3] = 255;
    }
  }
  octx.putImageData(odata, 0, 0);
  return { photo: { dataUrl: out.toDataURL('image/jpeg', 0.9), width: outW, height: outH }, H: Hf };
}

/** JPEG data URL of a photo, downscaled for upload to the analysis API. */
export async function photoForAnalysis(photo: Photo, maxSide = 2000): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(photo.dataUrl);
  const p = resizeImage(img, maxSide, 0.88);
  return { dataUrl: p.dataUrl, width: p.width, height: p.height };
}

/** Rasterise an SVG string to a PNG data URL at `pxPerMm`. */
export async function svgToPng(svg: string, widthMm: number, heightMm: number, pxPerMm = 11.811): Promise<string> {
  const w = Math.round(widthMm * pxPerMm);
  const h = Math.round(heightMm * pxPerMm);
  const sized = svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, `width="${w}" height="${h}"`);
  const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
  try {
    const img = await loadImage(url);
    const c = canvasOf(w, h);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(data: Blob | string, filename: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 5000);
}
