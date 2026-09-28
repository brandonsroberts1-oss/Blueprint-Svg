export const MM_PER_INCH = 25.4;
export const MM_PER_FT = 304.8;
export const INCH = 1 / 12;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Architectural feet-inches, e.g. 9.09375 -> 9'-1 1/8".
 * `denominator` is the inch fraction resolution (1 = whole inches, 8 = 1/8").
 */
export function formatFtIn(feet: number, denominator = 1): string {
  if (!isFinite(feet)) return '—';
  const sign = feet < 0 ? '-' : '';
  const totalUnits = Math.round(Math.abs(feet) * 12 * denominator);
  const ft = Math.floor(totalUnits / (12 * denominator));
  const rem = totalUnits - ft * 12 * denominator;
  const inches = Math.floor(rem / denominator);
  const frac = rem - inches * denominator;
  let inchStr = `${inches}`;
  if (frac > 0) {
    const g = gcd(frac, denominator);
    inchStr = `${inches > 0 ? inches + ' ' : ''}${frac / g}/${denominator / g}`;
  }
  return `${sign}${ft}'-${inchStr}"`;
}

/** Inches only for small sizes, e.g. 0.6667 ft -> 8". */
export function formatInches(feet: number, denominator = 1): string {
  const total = Math.round(Math.abs(feet) * 12 * denominator) / denominator;
  const whole = Math.floor(total);
  const frac = Math.round((total - whole) * denominator);
  if (frac === 0) return `${whole}"`;
  const g = gcd(frac, denominator);
  return `${whole > 0 ? whole + ' ' : ''}${frac / g}/${denominator / g}"`;
}

export function formatMeters(feet: number, decimals = 2): string {
  return `${(feet * 0.3048).toFixed(decimals)} m`;
}

/**
 * Parse a user-entered length into feet. Accepts 16', 16'-0", 6'8", 6' 8 1/2", 80", 80 in,
 * 6.5 ft, 2.4 m, 240 cm, 2400 mm, 7-0 (feet-inches), or a bare number (feet).
 */
export function parseLength(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/\s+/g, ' ');
  if (!s) return null;
  const num = (t: string) => {
    t = t.trim();
    const mixed = t.match(/^(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
    if (mixed) return parseFloat(mixed[1]) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
    const frac = t.match(/^(\d+)\/(\d+)$/);
    if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
    if (/^\d*\.?\d+$/.test(t)) return parseFloat(t);
    return NaN;
  };
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*-?\s*(?:(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(?:"|in|inch|inches)?)?$/);
  if (m) {
    const ft = parseFloat(m[1]);
    const inch = m[2] ? num(m[2]) : 0;
    return isNaN(inch) ? null : ft + inch / 12;
  }
  m = s.match(/^(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(?:"|in|inch|inches)$/);
  if (m) {
    const inch = num(m[1]);
    return isNaN(inch) ? null : inch / 12;
  }
  m = s.match(/^(\d+(?:\.\d+)?)\s*(mm|cm|m)$/);
  if (m) {
    const val = parseFloat(m[1]);
    const mm = m[2] === 'mm' ? val : m[2] === 'cm' ? val * 10 : val * 1000;
    return mm / MM_PER_FT;
  }
  m = s.match(/^(\d+)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (m) return parseInt(m[1], 10) + parseFloat(m[2]) / 12;
  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);
  return null;
}

export interface DrawingScale {
  id: string;
  /** Text used in the title block, e.g. 1/4" = 1'-0". */
  label: string;
  /** Real length / paper length. */
  ratio: number;
  system: 'imperial' | 'metric';
}

export const IMPERIAL_SCALES: DrawingScale[] = [
  { id: '1in', label: `1" = 1'-0"`, ratio: 12, system: 'imperial' },
  { id: '3/4in', label: `3/4" = 1'-0"`, ratio: 16, system: 'imperial' },
  { id: '1/2in', label: `1/2" = 1'-0"`, ratio: 24, system: 'imperial' },
  { id: '3/8in', label: `3/8" = 1'-0"`, ratio: 32, system: 'imperial' },
  { id: '1/4in', label: `1/4" = 1'-0"`, ratio: 48, system: 'imperial' },
  { id: '3/16in', label: `3/16" = 1'-0"`, ratio: 64, system: 'imperial' },
  { id: '1/8in', label: `1/8" = 1'-0"`, ratio: 96, system: 'imperial' },
  { id: '3/32in', label: `3/32" = 1'-0"`, ratio: 128, system: 'imperial' },
  { id: '1/16in', label: `1/16" = 1'-0"`, ratio: 192, system: 'imperial' },
  { id: '1/32in', label: `1/32" = 1'-0"`, ratio: 384, system: 'imperial' },
];

export const METRIC_SCALES: DrawingScale[] = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500].map((r) => ({
  id: `1:${r}`,
  label: `1:${r}`,
  ratio: r,
  system: 'metric' as const,
}));

export const ALL_SCALES = [...IMPERIAL_SCALES, ...METRIC_SCALES];

export const mmPerFoot = (scale: DrawingScale) => MM_PER_FT / scale.ratio;

/** Largest standard scale whose mm-per-foot does not exceed `maxMmPerFt`. */
export function pickStandardScale(maxMmPerFt: number, system: 'imperial' | 'metric'): DrawingScale | null {
  const list = system === 'imperial' ? IMPERIAL_SCALES : METRIC_SCALES;
  for (const s of list) if (mmPerFoot(s) <= maxMmPerFt * (1 + 1e-9)) return s;
  return null;
}

/** A non-standard scale that exactly fits (used when nothing standard fits). */
export function customScale(maxMmPerFt: number): DrawingScale {
  const ratio = Math.ceil(MM_PER_FT / maxMmPerFt);
  return { id: `custom:${ratio}`, label: `1:${ratio}`, ratio, system: 'metric' };
}

export function scaleById(id: string): DrawingScale | null {
  const s = ALL_SCALES.find((x) => x.id === id);
  if (s) return s;
  const m = id.match(/^custom:(\d+(?:\.\d+)?)$/);
  if (m) return { id, label: `1:${m[1]}`, ratio: parseFloat(m[1]), system: 'metric' };
  return null;
}

/** "31 x 7.5 in" style board size description. */
export function describeMm(mm: number, unit: 'mm' | 'in'): string {
  if (unit === 'mm') return `${Math.round(mm)} mm`;
  const inch = mm / MM_PER_INCH;
  return `${Math.round(inch * 100) / 100}"`;
}
