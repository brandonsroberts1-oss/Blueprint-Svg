import type { Vec } from './vec';

/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Solve A x = b (n x n) with partial pivoting. Returns null when singular. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography mapping each src[i] to dst[i] (exactly four correspondences). */
export function homographyFromPoints(src: readonly Vec[], dst: readonly Vec[]): Mat3 | null {
  if (src.length !== 4 || dst.length !== 4) throw new Error('need 4 point pairs');
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: w } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -w * x, -w * y]);
    b.push(w);
  }
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyH(H: Mat3, p: Vec): Vec {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Homogeneous w of the mapped point (sign flips across the horizon line). */
export function hW(H: Mat3, p: Vec): number {
  return H[6] * p.x + H[7] * p.y + H[8];
}

export function invertH(H: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const inv: Mat3 = [
    A,
    -(b * i - c * h),
    b * f - c * e,
    B,
    a * i - c * g,
    -(a * f - c * d),
    C,
    -(a * h - b * g),
    a * e - b * d,
  ];
  const s = 1 / det;
  return inv.map((x) => x * s) as Mat3;
}

export function multiplyH(A: Mat3, B: Mat3): Mat3 {
  const r: number[] = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]);
  return r as Mat3;
}

export interface AspectEstimate {
  /** Estimated real width / height of the rectangle. */
  aspect: number;
  /** Estimated focal length in pixels, or null when the view is (near) affine. */
  focal: number | null;
  method: 'perspective' | 'affine';
}

/**
 * Estimate the true aspect ratio of a rectangle seen in perspective
 * (Zhang & He, "Whiteboard scanning and image enhancement", 2007), assuming
 * square pixels and a principal point at the image centre.
 * Corners: top-left, top-right, bottom-right, bottom-left (image coordinates).
 */
export function estimateRectAspect(quad: readonly Vec[], imageW: number, imageH: number): AspectEstimate {
  const u0 = imageW / 2;
  const v0 = imageH / 2;
  const [tl, tr, br, bl] = quad;
  const m1 = [tl.x - u0, tl.y - v0, 1];
  const m2 = [tr.x - u0, tr.y - v0, 1];
  const m3 = [bl.x - u0, bl.y - v0, 1];
  const m4 = [br.x - u0, br.y - v0, 1];
  const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const m1x4 = cross3(m1, m4);
  const k2 = dot3(m1x4, m3) / dot3(cross3(m2, m4), m3);
  const k3 = dot3(m1x4, m2) / dot3(cross3(m3, m4), m2);
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  const affine = (): AspectEstimate => {
    const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
    const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    const right = Math.hypot(br.x - tr.x, br.y - tr.y);
    return { aspect: (top + bottom) / Math.max(1e-9, left + right), focal: null, method: 'affine' };
  };

  if (!isFinite(k2) || !isFinite(k3)) return affine();
  const nz = n2[2] * n3[2];
  const maxDim = Math.max(imageW, imageH);
  if (Math.abs(nz) > 1e-9) {
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / nz;
    // Plausible focal lengths: roughly 0.3x .. 10x the image size.
    if (f2 > (0.3 * maxDim) ** 2 && f2 < (10 * maxDim) ** 2) {
      const f = Math.sqrt(f2);
      const num = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
      const den = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
      const aspect = Math.sqrt(num / den);
      if (isFinite(aspect) && aspect > 0.05 && aspect < 20) return { aspect, focal: f, method: 'perspective' };
    }
  }
  return affine();
}
