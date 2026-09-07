// Assembles the deployable site/ directory. Vercel's outputDirectory for this
// project is "site" — only that folder ships — but site/index.html imports a
// handful of the repo's own instrumentation modules (scripts/lib/*,
// pages/lib/instrument.js) with relative paths that reach outside site/.
// Those resolve fine in local dev because scripts/local-server.mjs serves the
// whole repo root, but they 404 in production. This copies the exact modules
// index.html needs into site/vendor/, keeping the canonical source in
// scripts/lib and pages/lib as the single copy that ever gets hand-edited.
//
// It also DERIVES site/results-data.js from results/results.json — the
// measured study. That file is emitted rather than fetched at runtime for one
// specific reason: a page that fetches its own data can deploy successfully,
// 404 the JSON, and silently render an empty chart. Emitting it as a module
// makes a missing dataset a build failure instead of a quiet one, and every
// aggregate the page states ("median 71% smaller", "webgpu slower on 8 of 9")
// is COMPUTED here from the rows rather than typed into the markup.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FILES = [
  ['scripts/lib/models.mjs', 'site/vendor/scripts/lib/models.mjs'],
  ['scripts/lib/bytes.mjs', 'site/vendor/scripts/lib/bytes.mjs'],
  ['scripts/lib/resource-timing.mjs', 'site/vendor/scripts/lib/resource-timing.mjs'],
  ['pages/lib/instrument.js', 'site/vendor/pages/lib/instrument.js'],
  // Three type roles in three self-hosted OFL faces. No third-party font
  // request: a page that measures other people's network behaviour should not
  // quietly add its own.
  ['assets/fonts/SpaceGrotesk[wght].woff2', 'site/vendor/fonts/SpaceGrotesk[wght].woff2'],
  ['assets/fonts/SpaceGrotesk-OFL.txt', 'site/vendor/fonts/SpaceGrotesk-OFL.txt'],
  ['assets/fonts/Manrope[wght].woff2', 'site/vendor/fonts/Manrope[wght].woff2'],
  ['assets/fonts/Manrope-OFL.txt', 'site/vendor/fonts/Manrope-OFL.txt'],
  ['assets/fonts/JetBrainsMono[wght].woff2', 'site/vendor/fonts/JetBrainsMono[wght].woff2'],
  ['assets/fonts/JetBrainsMono-OFL.txt', 'site/vendor/fonts/JetBrainsMono-OFL.txt'],
  // The measured study, shipped so a visitor can check any figure on the page
  // against the raw rows rather than taking the chart's word for it.
  ['results/results.json', 'site/results.json'],
];

for (const [src, dest] of FILES) {
  const srcPath = path.join(ROOT, src);
  const destPath = path.join(ROOT, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`build-site: ${src} -> ${dest}`);
}

/* ---------------------------------------------------------------- results -- */

const study = JSON.parse(fs.readFileSync(path.join(ROOT, 'results/results.json'), 'utf8'));
const ok = study.rows.filter((r) => r.status === 'ok');
const failed = study.rows.filter((r) => r.status !== 'ok');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const deltas = ok.map((r) => r.bytes.deltaVsAdvertised.deltaPercent);

// webgpu vs wasm on the same model — only models measured on both devices.
const byModel = {};
for (const r of ok) {
  byModel[r.modelId] ??= {};
  byModel[r.modelId][r.device] = r;
}
const pairs = Object.values(byModel).filter((m) => m.wasm && m.webgpu);
const webgpuSlower = pairs.filter(
  (m) => m.webgpu.timing.coldLoadToFirstInferenceMs > m.wasm.timing.coldLoadToFirstInferenceMs,
).length;

const revisits = ok.filter((r) => r.bytes.revisit).map((r) => r.bytes.revisit);

// One card per model, using the wasm row where present (it is the default
// execution provider transformers.js picks) so the bar chart compares like
// with like rather than mixing devices.
const models = Object.entries(byModel).map(([id, m]) => {
  const base = m.wasm ?? m.webgpu;
  return {
    id,
    repo: base.repo,
    task: base.task,
    dtype: base.dtype,
    notes: base.notes ?? null,
    advertisedBytes: base.bytes.advertisedBytes,
    advertisedSource: base.bytes.advertisedSource,
    measuredBytes: base.bytes.coldTotalTransferBytes,
    measuredHuman: base.bytes.coldTotalTransferHuman,
    deltaPercent: base.bytes.deltaVsAdvertised.deltaPercent,
    byOrigin: base.bytes.byOrigin,
    coldMs: { wasm: m.wasm?.timing.coldLoadToFirstInferenceMs ?? null, webgpu: m.webgpu?.timing.coldLoadToFirstInferenceMs ?? null },
    warmMs: { wasm: m.wasm?.timing.warmLoadToFirstInferenceMs ?? null, webgpu: m.webgpu?.timing.warmLoadToFirstInferenceMs ?? null },
    peakHeap: { wasm: m.wasm?.heap.peakJsHeapHuman ?? null, webgpu: m.webgpu?.heap.peakJsHeapHuman ?? null },
    provider: { wasm: m.wasm?.provider.actualProvider ?? null, webgpu: m.webgpu?.provider.actualProvider ?? null },
    revisitSavings: base.bytes.revisit?.savingsRatio ?? null,
    warmBytes: base.bytes.warmTotalTransferBytes,
    failedOn: study.rows.filter((r) => r.modelId === id && r.status !== 'ok').map((r) => r.device),
  };
});

const summary = {
  generatedAt: study.generatedAt,
  rows: study.rows.length,
  okRows: ok.length,
  failedRows: failed.length,
  modelCount: models.length,
  medianDeltaPercent: median(deltas),
  bestDeltaPercent: Math.min(...deltas),
  worstDeltaPercent: Math.max(...deltas),
  webgpuSlowerColdOn: webgpuSlower,
  webgpuPairs: pairs.length,
  cacheHonouredEverywhere: revisits.every((r) => r.cacheHonored),
  minRevisitSavings: Math.min(...revisits.map((r) => r.savingsRatio)),
  fastestColdMs: Math.min(...ok.map((r) => r.timing.coldLoadToFirstInferenceMs)),
  slowestColdMs: Math.max(...ok.map((r) => r.timing.coldLoadToFirstInferenceMs)),
  totalMeasuredBytes: ok.reduce((a, r) => a + r.bytes.coldTotalTransferBytes, 0),
  machine: study.machineProfile,
  failures: failed.map((r) => ({
    modelId: r.modelId,
    device: r.device,
    error: (r.error ?? '').split('\n')[0].slice(0, 220),
  })),
};

const out = path.join(ROOT, 'site/results-data.js');
fs.writeFileSync(
  out,
  '// GENERATED by scripts/build-site.mjs from results/results.json — do not hand-edit.\n' +
    '// Every aggregate below is computed from the measured rows, never typed in.\n' +
    `export const SUMMARY = ${JSON.stringify(summary, null, 2)};\n` +
    `export const MODELS = ${JSON.stringify(models, null, 2)};\n` +
    `export const METHOD_NOTES = ${JSON.stringify(study.methodNotes, null, 2)};\n`,
);
console.log(
  `build-site: results/results.json -> site/results-data.js ` +
    `(${models.length} models, ${summary.okRows} ok / ${summary.failedRows} failed)`,
);

console.log('build-site: done.');
