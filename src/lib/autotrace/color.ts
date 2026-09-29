/** Colour helpers: sRGB → CIELAB and a small Gaussian colour model. */

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const LIN = Float32Array.from({ length: 256 }, (_, i) => lin(i));
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** RGBA pixels → interleaved L, a, b floats. */
export function rgbaToLab(data: Uint8ClampedArray, n: number): Float32Array {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = LIN[data[i * 4]];
    const g = LIN[data[i * 4 + 1]];
    const b = LIN[data[i * 4 + 2]];
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const fx = fLab(x);
    const fy = fLab(y);
    const fz = fLab(z);
    out[i * 3] = 116 * fy - 16;
    out[i * 3 + 1] = 500 * (fx - fy);
    out[i * 3 + 2] = 200 * (fy - fz);
  }
  return out;
}

/** Multivariate normal in 3-D colour space. */
export interface Gauss3 {
  mean: [number, number, number];
  /** Inverse covariance (row-major 3×3). */
  inv: number[];
  logDet: number;
  n: number;
}

/** Fit a Gaussian to the colours at `idx` (pixel indices). `minVar` regularises flat regions. */
export function fitGauss(lab: Float32Array, idx: ArrayLike<number>, minVar = 9): Gauss3 | null {
  const n = idx.length;
  if (n < 8) return null;
  const m = [0, 0, 0];
  for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) m[c] += lab[idx[k] * 3 + c];
  for (let c = 0; c < 3; c++) m[c] /= n;
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const d0 = lab[idx[k] * 3] - m[0];
    const d1 = lab[idx[k] * 3 + 1] - m[1];
    const d2 = lab[idx[k] * 3 + 2] - m[2];
    S[0] += d0 * d0;
    S[1] += d0 * d1;
    S[2] += d0 * d2;
    S[4] += d1 * d1;
    S[5] += d1 * d2;
    S[8] += d2 * d2;
  }
  for (const i of [0, 1, 2, 4, 5, 8]) S[i] /= n;
  S[3] = S[1];
  S[6] = S[2];
  S[7] = S[5];
  S[0] += minVar;
  S[4] += minVar;
  S[8] += minVar;
  const det = S[0] * (S[4] * S[8] - S[5] * S[7]) - S[1] * (S[3] * S[8] - S[5] * S[6]) + S[2] * (S[3] * S[7] - S[4] * S[6]);
  if (!(det > 0)) return null;
  const inv = [
    (S[4] * S[8] - S[5] * S[7]) / det,
    (S[2] * S[7] - S[1] * S[8]) / det,
    (S[1] * S[5] - S[2] * S[4]) / det,
    (S[5] * S[6] - S[3] * S[8]) / det,
    (S[0] * S[8] - S[2] * S[6]) / det,
    (S[2] * S[3] - S[0] * S[5]) / det,
    (S[3] * S[7] - S[4] * S[6]) / det,
    (S[1] * S[6] - S[0] * S[7]) / det,
    (S[0] * S[4] - S[1] * S[3]) / det,
  ];
  return { mean: [m[0], m[1], m[2]], inv, logDet: Math.log(det), n };
}

/** Squared Mahalanobis distance of pixel `i` to the model. */
export function mahal2(g: Gauss3, lab: Float32Array, i: number): number {
  const d0 = lab[i * 3] - g.mean[0];
  const d1 = lab[i * 3 + 1] - g.mean[1];
  const d2 = lab[i * 3 + 2] - g.mean[2];
  const v = g.inv;
  return d0 * (v[0] * d0 + v[1] * d1 + v[2] * d2) + d1 * (v[3] * d0 + v[4] * d1 + v[5] * d2) + d2 * (v[6] * d0 + v[7] * d1 + v[8] * d2);
}

/** Negative log-likelihood (up to a constant). */
export const nll = (g: Gauss3, lab: Float32Array, i: number) => 0.5 * (mahal2(g, lab, i) + g.logDet);
