import { fetchJson } from './http';

interface EpqsResponse {
  value?: number | string;
}

/** Ground elevation above sea level (feet) from the USGS Elevation Point Query Service (US only). */
export async function elevationFt(lat: number, lon: number): Promise<number | null> {
  const url = 'https://epqs.nationalmap.gov/v1/json?' + new URLSearchParams({ x: String(lon), y: String(lat), wkid: '4326', units: 'Feet', includeDate: 'false' });
  const data = await fetchJson<EpqsResponse>(url, { timeoutMs: 12000 });
  return parseElevation(data);
}

export function parseElevation(data: EpqsResponse): number | null {
  const v = typeof data.value === 'string' ? parseFloat(data.value) : data.value;
  if (typeof v !== 'number' || !isFinite(v) || v < -1000) return null;
  return v;
}
