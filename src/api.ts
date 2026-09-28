import type { AnalyzeResponse } from './lib/shared/analysisSchema';
import type { PropertyLookup, ServerConfig } from './lib/shared/property';

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function getConfig(): Promise<ServerConfig> {
  try {
    return await json<ServerConfig>(await fetch('/api/config'));
  } catch {
    return { ai: false, aiModel: null, recordProviders: [] };
  }
}

export async function lookupAddress(address: string): Promise<PropertyLookup> {
  return json<PropertyLookup>(await fetch(`/api/property?address=${encodeURIComponent(address)}`));
}

export async function analyzeImage(image: string, width: number, height: number): Promise<AnalyzeResponse> {
  return json<AnalyzeResponse>(
    await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, width, height }),
    }),
  );
}
