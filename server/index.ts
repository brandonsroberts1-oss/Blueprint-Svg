import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api';

try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env file */
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const port = Number(process.env.PORT ?? 5173);

const app = express();
app.disable('x-powered-by');
app.use('/api', createApi());

if (production) {
  const dist = join(root, 'dist');
  if (!existsSync(dist)) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  app.use(express.static(dist, { index: 'index.html', maxAge: '1h' }));
  app.use((_req, res) => res.sendFile(join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(port, () => {
  console.log(`Blueprint Engraver running at http://localhost:${port}${production ? '' : ' (dev)'}`);
});
