import express, { type Request, type Response } from 'express';
import type { AnalyzeRequest } from '../src/lib/shared/analysisSchema';
import type { ServerConfig } from '../src/lib/shared/property';
import { AnalysisError, analysisAvailable, analysisModel, analyzePhoto } from './analyze';
import { lookupProperty, recordProviders } from './property/index';

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: '20mb' }));

  api.get('/config', (_req: Request, res: Response) => {
    const cfg: ServerConfig = { ai: analysisAvailable(), aiModel: analysisAvailable() ? analysisModel() : null, recordProviders: recordProviders() };
    res.json(cfg);
  });

  api.get('/property', async (req: Request, res: Response) => {
    const address = String(req.query.address ?? '').trim();
    if (address.length < 5) {
      res.status(400).json({ error: 'Enter a street address.' });
      return;
    }
    try {
      res.json(await lookupProperty(address));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  api.post('/analyze', async (req: Request, res: Response) => {
    if (!analysisAvailable()) {
      res.status(501).json({ error: 'AI tracing is not configured. Set ANTHROPIC_API_KEY on the server.' });
      return;
    }
    try {
      res.json(await analyzePhoto(req.body as AnalyzeRequest));
    } catch (e) {
      const status = e instanceof AnalysisError ? e.status : 500;
      res.status(status).json({ error: (e as Error).message });
    }
  });

  return api;
}
