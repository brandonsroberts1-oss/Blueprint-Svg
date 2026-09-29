# Blueprint Engraver

Turn a photo of a house into an architectural **front-elevation blueprint** — to scale, with
callouts, level lines and a title block — and export an SVG that engraves cleanly on an
**xTool** (or any) laser.

![Example sheet: 18 × 12 in board at 1/4" = 1'-0"](docs/example-blueprint.png)

## What it does

1. **Photo & address** — upload a photo of the front of the house and (optionally) look up the
   address in public records: official address, coordinates, ground elevation, the building
   footprint from OpenStreetMap (for the real facade width), and — with an API key — assessor
   data such as year built, square footage, beds/baths, lot size and parcel number. Tick which
   facts to print under the title.
2. **Straighten** — drag four corners onto a rectangle on the front wall. The app estimates the
   rectangle's true proportions from the perspective, warps the photo so the facade is
   face-on, and (if you enter a known width) sets the drawing scale at the same time.
3. **Trace** — the house is **auto-traced for free, on your device**, right after straightening:
   walls, roofs, gables, windows, doors, garage doors and lights. Fine-tune anything by dragging
   corners, or outline walls, roofs, gables and chimneys yourself and drop boxes on windows,
   doors, garage doors, vents, columns, railings, steps, trim and lights. Each element has
   architectural options (siding type, grilles, door style, sidelights, garage panels, shutters…).
   The generated blueprint linework is overlaid on the photo so you can check alignment.
4. **Callouts & details** — callouts with leader arrows are generated from the tracing
   (“ARCHITECTURAL ASPHALT SHINGLES”, “16'-0" x 7'-0" OVERHEAD GARAGE DOOR”, “STONE VENEER
   WAINSCOT W/ CAP”…). Edit the wording, hide any, add your own notes, and adjust the level lines
   (FIRST FLOOR, SECOND FLOOR, TRUSS BEARING, RIDGE).
5. **Size & export** — pick the board (presets for common boards and xTool work areas). The app
   chooses the largest **standard architectural scale** that fits (e.g. 1/8" = 1'-0",
   1/4" = 1'-0", or metric 1:50), so the scale note, graphic scale bar and dimensions are exact on
   the finished piece. Download the laser SVG, a blueprint-blue SVG, or a 300 dpi PNG proof.

![Tracing editor with the blueprint overlay](docs/editor.png)

## Use it

**Live site:** https://brandonsroberts1-oss.github.io/Blueprint-Svg/ — a static web app that runs
entirely in your browser. Photos, tracings and keys never leave your computer except for the
public-record and AI requests described below. Click **Demo** in the header to load a sample
house and explore every step without a photo.

### Publishing on GitHub Pages

The workflow in `.github/workflows/deploy-pages.yml` builds the site, runs the tests and publishes
it to the `gh-pages` branch on every push to `main` (and to the feature branch it was built on).
One-time setup in the repository: **Settings → Pages → Build and deployment → Source: Deploy from
a branch → Branch: `gh-pages`, folder `/ (root)` → Save**. The site appears at
`https://<owner>.github.io/<repo>/` a minute later.

Because the build uses relative paths, the `dist/` folder also works on any other static host
(Netlify, Cloudflare Pages, S3…).

### Run locally

```bash
npm install
npm run dev               # http://localhost:5173
npm run build             # static site in dist/
npm run preview           # serve the built site
```

### Settings (⚙ in the header, all optional)

| Setting | Enables |
|---|---|
| Anthropic API key | Optional **tracing with Claude** instead of the free on-device auto-trace (default model `claude-opus-5`). Create a key at [console.anthropic.com](https://console.anthropic.com/settings/keys); usage is billed to your account. |
| RentCast API key | Assessor data via [RentCast](https://www.rentcast.io/api) (free developer tier). |
| ATTOM API key | Assessor data via [ATTOM](https://api.developer.attomdata.com) (used if RentCast isn't set). |
| Contact email | Sent to OpenStreetMap Nominatim with address searches, as its usage policy asks. |

Keys are stored only in your browser (local storage, or for the current tab only if you untick
**Remember on this device**) and are sent only to their own service. They are never written into
saved project files or into the published site. Every GitHub Pages site under the same account
shares one browser storage origin, so only keep keys there if you trust your other Pages sites;
**Forget all keys** removes them.

Without any keys the app still works end to end: auto-trace runs on your device, and the address lookup uses
the free sources (US Census geocoder, OpenStreetMap Nominatim + Overpass, USGS / Open-Meteo
elevation). Some services don't accept requests from web pages (browser CORS rules) — each
source reports its own status, and anything missing can be typed in by hand.

## Getting an accurate scale

The drawing is only as accurate as its scale reference. In step 3 → **Scale**:

- **Standard doors** (default): assumes a 6'-8" entry door and a 7'-0" garage door. Good to a few
  percent on typical US houses.
- **Measured line**: draw a line along anything you know the length of (a garage door, a window
  you measured, the wall width) and type the length. Most accurate.
- **Facade width**: uses the wall-to-wall width — for example the street-facing width of the
  building footprint found by the address lookup.

A known width typed in the **Straighten** step also sets a measured reference automatically.
Photos taken straight on, from farther away with a longer lens, straighten best; very wide-angle
phone shots up close exaggerate perspective.

## Engraving on an xTool

The laser SVG is designed to import cleanly into **xTool Creative Space** (and LightBurn):

- Real-world size: `width`/`height` are in **millimetres** and 1 SVG unit = 1 mm, so the design
  should import at exactly the board size you chose (check the size readout after importing).
- **Only stroked paths** — no fills, bitmaps, `<text>`, transforms or CSS. All lettering is drawn
  with **single-line (engraving) fonts**, so each letter is one clean pass in *Score* mode.
- Overlapping lines are merged, so nothing gets burned twice.
- Each line weight is its own colour and group, so you can give outlines more power than
  hatching to get real drafting line weights:

  | Colour | Group | Contents |
  |---|---|---|
  | black `#000000` | Outlines | building silhouette, roof/wall edges, grade line, frame |
  | blue `#0000FF` | Details | windows, doors, trim, fascia, columns |
  | green `#00A000` | Hatching | siding, shingles, brick, stone, grilles |
  | magenta `#FF00FF` | Annotation lines | leaders, dimension and level lines |
  | orange `#FF8000` | Lettering | all text |
  | red `#FF0000` | Cut line | optional plaque outline (rectangle or rounded) |

  Prefer one setting for everything? Choose **Laser colours → Everything black**.
- Hatch spacing is automatically thinned so parallel lines stay at least **Min line gap**
  (0.9 mm by default) apart and don't char together; raise it for softer woods.

Typical workflow in XCS: import the SVG → select the drawing → set processing to **Score** →
adjust power/speed per colour → run a test on scrap → engrave. Set the red outline to **Cut** if
you want the plaque cut out.

## Public records & privacy

The lookup runs in your browser and calls each public service directly. It never reads or prints
owner names — only facts about the building. OpenStreetMap footprints are © OpenStreetMap contributors (ODbL); Census and USGS data
are public domain; RentCast/ATTOM data is subject to their terms.

## Auto-trace (free, on-device)

Auto-trace needs no account or API key and the photo never leaves the browser. Three small
open models run in a web worker with [ONNX Runtime Web](https://onnxruntime.ai/):

| Model | Finds |
|---|---|
| YOLO26s semantic segmentation (ADE20K) | the house outline against sky, trees and ground |
| YOLOv8s trained on Open Images | windows and doors |
| YOLOE-26s with fixed text prompts | garage doors, exterior lights, chimneys |

A parser then turns those into the drawing: it finds the grade line and roofline, traces the
eave as the strongest continuous change from roof to wall (dynamic programming over colour and
texture, kept above every window and door), and builds wall rectangles per wing, roof and gable
polygons, porch roofs and the openings. The first run downloads about 34 MB of models (cached
for next time); after that a trace takes a few seconds. Results are a first draft — check the
shapes against the photo, especially where trees hide the house.

The models live in `public/models/`; `scripts/export-models.py` rebuilds them from the
Ultralytics releases.

### Tracing with Claude (optional)

With an Anthropic key in Settings, **Or trace with Claude** sends the straightened photo
(downscaled to 2000 px) from your browser to the Claude API with a structured-output schema
and turns the response into editable elements. The Anthropic SDK is loaded only when you use
it, and server-side refusal fallbacks are enabled (`fallbacks: "default"`).

## Development

```bash
npm test          # unit tests (geometry, fonts, renderer, address parsing, AI mapping, auto-trace)
npm run typecheck
npx tsx scripts/render-demo.ts out/   # render the demo house to SVG from the command line
```

```
src/lib/
  autotrace/       on-device auto-trace: model runner (web worker), mask tools, house parser
  property/        Census + Nominatim geocoding, OSM footprint analysis, elevation, RentCast/ATTOM
  ai/              Claude vision tracing with structured outputs (lazy-loaded)
  settings.ts      per-browser API keys and preferences
  geometry/        vectors, polygons, clipping & hatching, homography + perspective aspect estimate
  text/            single-line stroke fonts and text layout
  model/           project types, defaults, scale calibration, level lines, AI/record mapping
  render/          element linework, materials, hidden-line removal, callouts, sheet layout, SVG
  image/           photo import, perspective warp, PNG export
src/components/    React UI for the five steps
```

### Credits

- **EMS Tech** single-line font (SIL OFL 1.1) by Sheldon B. Michaels / Evil Mad Scientist
  Laboratories, derived from *Architects Daughter* by Kimberly Geswein; **Hershey Sans**
  (public domain). See `src/lib/text/fonts/FONTS-LICENSE.md`.
- Perspective aspect-ratio estimation after Zhang & He, *Whiteboard scanning and image
  enhancement* (2007).
- Auto-trace models by [Ultralytics](https://github.com/ultralytics/ultralytics) (YOLO26,
  YOLOv8 Open Images V7, YOLOE), licensed **AGPL-3.0** — fine for this open-source app; a
  closed-source commercial product would need an Ultralytics enterprise licence. Trained on
  ADE20K, Open Images and Objects365 data. Runtime: ONNX Runtime Web (MIT).
