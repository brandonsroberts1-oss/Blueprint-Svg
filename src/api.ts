import { lookupProperty } from './lib/property/index';
import type { Settings } from './lib/settings';
import type { AnalyzeResponse } from './lib/shared/analysisSchema';
import type { PropertyLookup } from './lib/shared/property';

/** Public-record lookup, straight from the browser to each public service. */
export function lookupAddress(address: string, s: Settings): Promise<PropertyLookup> {
  return lookupProperty(address, { rentcastKey: s.rentcastKey, attomKey: s.attomKey, email: s.email });
}

/** AI tracing with the user's own Anthropic key. The SDK is loaded only when first used. */
export async function analyzeImage(image: string, width: number, height: number, s: Settings): Promise<AnalyzeResponse> {
  const { analyzePhoto } = await import('./lib/ai/analyze');
  return analyzePhoto({ image, width, height }, { apiKey: s.anthropicKey, model: s.model });
}
