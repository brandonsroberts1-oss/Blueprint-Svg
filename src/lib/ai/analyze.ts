import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { DEFAULT_MODEL } from '../settings';
import { AnalysisSchema, type AnalyzeRequest, type AnalyzeResponse } from '../shared/analysisSchema';

export interface AnalyzeOptions {
  /** The user's own Anthropic API key (kept in their browser). */
  apiKey: string;
  model?: string;
}

/**
 * Client for calling the Claude API straight from the browser. This is a static site,
 * so there is no server to hold a key: users paste their own key, which stays in their
 * browser and is sent only to api.anthropic.com.
 */
export function browserClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
}

const SYSTEM = `You are an architectural drafter who traces photographs of houses into front-elevation drawings.
You return precise pixel geometry for every visible element of the front facade so a drafting program can redraw it as a clean blueprint.`;

function instructions(width: number, height: number): string {
  return `The image is ${width} x ${height} pixels (x to the right, y downward, origin at the top-left). It shows the front of a house, perspective-corrected so the front wall is roughly face-on.

Trace the front elevation as a list of elements in this image's pixel coordinates:
- wall: each visible area of exterior wall as a polygon (not roofs). Use one wall per cladding material. A stone or brick wainscot along the bottom gets its own wall polygon covering just that band.
- roof: each visible roof surface whose eave faces the camera, as a polygon from the gutter/eave line up to the ridge or to where it meets another roof. Porch roofs count.
- gable: each front-facing gable (triangle under two sloped roof edges) as a polygon that includes its rake trim.
- chimney: the visible chimney outline as a polygon.
- window, door, garage, vent, column, railing, steps, trim, light: axis-aligned boxes that include their trim or casing. Use one door box for an entry including sidelights and transom. Use one window box for windows mulled together and set "units".

List elements in back-to-front painting order: main walls, then roof surfaces, then gables that sit in front of roofs, then wainscots/material bands, then windows, doors, garage doors, vents, trim boards and lights, and finally porch columns, railings and steps.

Accuracy matters more than completeness: align every edge with the edge visible in the photo. Where trees, cars or shadows hide part of the house, infer the hidden outline from symmetry and typical construction. Ignore landscaping, vehicles, people, fences, mailboxes and neighbouring houses.

Set groundY to the finish grade at the foot of the front wall. Fill only the fields that apply to each kind and set the others to null. For windows, gridCols/gridRows are panes per sash (e.g. a 6-over-6 double-hung window is 3 x 2). For garage doors give the number of horizontal sections and whether the top section has windows.`;
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

function parseDataUrl(dataUrl: string): { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string } {
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) throw new AnalysisError('Expected a base64 JPEG, PNG or WebP data URL.', 400);
  return { mediaType: m[1] as 'image/jpeg' | 'image/png' | 'image/webp', data: m[2] };
}

export async function analyzePhoto(req: AnalyzeRequest, opts: AnalyzeOptions, client?: Anthropic): Promise<AnalyzeResponse> {
  if (!req?.image || !(req.width > 0) || !(req.height > 0)) throw new AnalysisError('Missing image or size.', 400);
  const { mediaType, data } = parseDataUrl(req.image);
  if (data.length > 7_000_000) throw new AnalysisError('Image is too large; send at most ~5 MB.', 413);
  if (!client && !opts.apiKey.trim()) throw new AnalysisError('Add your Anthropic API key in Settings to use AI tracing.', 401);
  const model = opts.model?.trim() || DEFAULT_MODEL;
  const api = client ?? browserClient(opts.apiKey.trim());

  try {
    const response = await api.beta.messages.parse({
      model,
      max_tokens: 16000,
      // Server-side fallback: if the model declines, the API retries on a recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
            { type: 'text', text: instructions(Math.round(req.width), Math.round(req.height)) },
          ],
        },
      ],
      output_config: { format: betaZodOutputFormat(AnalysisSchema) },
    });

    if (response.stop_reason === 'refusal') throw new AnalysisError('The model declined to analyse this image.', 422);
    if (response.stop_reason === 'max_tokens') throw new AnalysisError('The analysis was cut off; try a simpler or smaller photo.', 502);
    const analysis = response.parsed_output;
    if (!analysis) throw new AnalysisError('The model did not return a usable tracing.', 502);
    return { analysis, model: response.model ?? model, width: req.width, height: req.height };
  } catch (err) {
    if (err instanceof AnalysisError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AnalysisError('Your Anthropic API key was rejected — check it in Settings.', 401);
    if (err instanceof Anthropic.PermissionDeniedError) throw new AnalysisError(`Your Anthropic key doesn't have access to ${model}: ${err.message}`, 403);
    if (err instanceof Anthropic.APIConnectionError) throw new AnalysisError('Could not reach api.anthropic.com from this browser — check your connection.', 503);
    if (err instanceof Anthropic.RateLimitError) throw new AnalysisError('Rate limited by the Anthropic API — try again shortly.', 429);
    if (err instanceof Anthropic.BadRequestError) throw new AnalysisError(`The Anthropic API rejected the request: ${err.message}`, 400);
    if (err instanceof Anthropic.APIError) throw new AnalysisError(`Anthropic API error ${err.status ?? ''}: ${err.message}`, 502);
    throw new AnalysisError(`Analysis failed: ${(err as Error).message}`, 500);
  }
}
