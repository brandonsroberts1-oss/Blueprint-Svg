// Render the demo house to SVG files (and optionally PNG previews via Playwright).
//   npx tsx scripts/render-demo.ts [outDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { demoProject } from '../src/lib/model/demo';
import { buildSheet } from '../src/lib/render/sheet';
import { strokesToSvg } from '../src/lib/render/svg';

const outDir = process.argv[2] ?? 'demo-out';
mkdirSync(outDir, { recursive: true });
const project = demoProject();
const t0 = performance.now();
const sheet = buildSheet(project);
const ms = performance.now() - t0;
const title = 'Front elevation — demo';
writeFileSync(join(outDir, 'demo-laser.svg'), strokesToSvg(sheet.widthMm, sheet.heightMm, sheet.strokes, { mode: 'laser', colorMode: 'layers', title }));
writeFileSync(join(outDir, 'demo-blueprint.svg'), strokesToSvg(sheet.widthMm, sheet.heightMm, sheet.strokes, { mode: 'blueprint', colorMode: 'layers', title }));
console.log(`scale ${sheet.scale?.label}  ${sheet.mmPerFt.toFixed(3)} mm/ft  house ${sheet.houseWidthFt?.toFixed(1)} ft wide`);
console.log(`${sheet.stats.polylines} polylines, ${(sheet.stats.lengthMm / 1000).toFixed(1)} m of line, built in ${ms.toFixed(0)} ms`);
console.log('callouts placed:', sheet.callouts.filter((c) => c.placed).map((c) => `${c.side[0]}:${c.text || c.key}`).join(' | '));
console.log('not placed:', sheet.callouts.filter((c) => !c.placed).map((c) => c.text || c.key).join(' | '));
console.log('levels:', sheet.levels.map((l) => `${l.name}@${l.heightFt.toFixed(2)}`).join(', '));
console.log('warnings:', sheet.warnings);
