import { fetchJson } from './http';

interface EpqsResponse {
  value?: number | string;
}

/** Ground elevation above sea level (feet) from the USGS Elevation Point Query Service (US only). */
export async function elevationFt(lat: number, lon: number): Promise<number | null> {
  const url = 'https://epqs.nationalmap.gov/v1/json?' + new URLSearchParams({ x: String(lon), y: String(lat), wkid: '4326', units: 'Feet', includeDate: 'false' });
  const data = await fetchJson<EpqsResponse>(url, { timeoutMs: 10000 });
  return parseElevation(data);
}

interface OpenMeteoResponse {
  elevation?: number[];
}

/** Fallback: Open-Meteo elevation API (worldwide, ~90 m terrain model, metres). */
export async function elevationFtOpenMeteo(lat: number, lon: number): Promise<number | null> {
  const url = 'https://api.open-meteo.com/v1/elevation?' + new URLSearchParams({ latitude: String(lat), longitude: String(lon) });
  const data = await fetchJson<OpenMeteoResponse>(url, { timeoutMs: 10000 });
  return parseOpenMeteo(data);
}

export function parseOpenMeteo(data: OpenMeteoResponse): number | null {
  const m = data.elevation?.[0];
  return typeof m === 'number' && isFinite(m) && m > -500 ? m * 3.28084 : null;
}

export function parseElevation(data: EpqsResponse): number | null {
  const v = typeof data.value === 'string' ? parseFloat(data.value) : data.value;
  if (typeof v !== 'number' || !isFinite(v) || v < -1000) return null;
  return v;
}
