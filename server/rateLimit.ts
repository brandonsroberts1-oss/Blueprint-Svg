import type { NextFunction, Request, Response } from 'express';

/** Tiny fixed-window, per-IP rate limiter (no external store; fine for a single server). */
export function rateLimit(opts: { windowMs: number; max: number; name: string }) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let h = hits.get(key);
    if (!h || now > h.reset) {
      h = { count: 0, reset: now + opts.windowMs };
      hits.set(key, h);
      if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    h.count++;
    if (h.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      res.status(429).json({ error: `Too many ${opts.name} requests — try again in a few minutes.` });
      return;
    }
    next();
  };
}
