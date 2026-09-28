#!/usr/bin/env node
// Converts single-line SVG fonts (from the `hersheytext` npm package, `svg_fonts/`)
// into the compact JSON glyph tables used by src/lib/text/.
//
// Usage:
//   npm pack hersheytext && tar xzf hersheytext-*.tgz
//   node scripts/build-fonts.mjs package/svg_fonts
//
// Only M/L path commands occur in these fonts, so every glyph becomes a list of
// polylines in font units (y up, baseline at 0).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: node scripts/build-fonts.mjs <path to hersheytext/svg_fonts>');
  process.exit(1);
}
const outDir = join(here, '..', 'src', 'lib', 'text', 'fonts');
mkdirSync(outDir, { recursive: true });

const FONTS = [
  {
    file: 'EMSTech.svg',
    out: 'ems-tech.json',
    name: 'EMS Tech',
    license: 'SIL Open Font License 1.1 — EMS Tech by Sheldon B. Michaels, SVG conversion by Windell H. Oskay; derivative of Architects Daughter by Kimberly Geswein',
  },
  {
    file: 'HersheySans1.svg',
    out: 'hershey-sans.json',
    name: 'Hershey Sans 1-stroke',
    license: 'Hershey fonts — public domain (A. V. Hershey, U.S. National Bureau of Standards); SVG conversion by Evil Mad Scientist Laboratories',
  },
];

const EXTRA = ['°', '×', '±', '½', '¼', '¾', '·', '—', '–'];

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function parsePath(d) {
  const strokes = [];
  let cur = null;
  const tokens = d.trim().split(/\s+/);
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    if (t === 'M' || t === 'L') {
      const x = Math.round(parseFloat(tokens[i + 1]));
      const y = Math.round(parseFloat(tokens[i + 2]));
      if (t === 'M' || !cur) {
        cur = [x, y];
        strokes.push(cur);
      } else {
        cur.push(x, y);
      }
      i += 3;
    } else {
      throw new Error(`Unsupported path token "${t}"`);
    }
  }
  return strokes.filter((s) => s.length >= 4);
}

for (const font of FONTS) {
  const svg = readFileSync(join(srcDir, font.file), 'utf8');
  const fontTag = svg.match(/<font\s[^>]*>/)[0];
  const defaultAdvance = parseFloat(attr(fontTag, 'horiz-adv-x'));
  const faceTag = svg.match(/<font-face[\s\S]*?\/>/)[0];
  const unitsPerEm = parseFloat(attr(faceTag, 'units-per-em'));

  const glyphs = {};
  for (const m of svg.matchAll(/<glyph\s[^>]*?\/>/g)) {
    const tag = m[0];
    const uni = attr(tag, 'unicode');
    if (uni === undefined) continue;
    const ch = decodeEntities(uni);
    if ([...ch].length !== 1) continue;
    const code = ch.codePointAt(0);
    if (!((code >= 32 && code <= 126) || EXTRA.includes(ch))) continue;
    const adv = parseFloat(attr(tag, 'horiz-adv-x') ?? String(defaultAdvance));
    const d = attr(tag, 'd');
    glyphs[ch] = { a: Math.round(adv), p: d ? parsePath(d) : [] };
  }

  // Measure the real cap height from flat-topped capitals.
  let capHeight = 0;
  for (const ch of ['H', 'E', 'T', 'I']) {
    const g = glyphs[ch];
    if (!g) continue;
    let top = 0;
    for (const s of g.p) for (let i = 1; i < s.length; i += 2) top = Math.max(top, s[i]);
    capHeight = Math.max(capHeight, top);
  }

  const out = {
    name: font.name,
    license: font.license,
    unitsPerEm,
    capHeight,
    defaultAdvance: Math.round(defaultAdvance),
    glyphs,
  };
  writeFileSync(join(outDir, font.out), JSON.stringify(out));
  console.log(`${font.out}: ${Object.keys(glyphs).length} glyphs, cap height ${capHeight}`);
}
