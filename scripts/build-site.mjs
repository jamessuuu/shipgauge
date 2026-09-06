// Assembles the deployable site/ directory. Vercel's outputDirectory for this
// project is "site" — only that folder's contents ship to production, but
// site/index.html imports a handful of the repo's own instrumentation
// modules (scripts/lib/*, pages/lib/instrument.js) with relative paths that
// reach outside site/. Those paths resolve fine in local dev because
// scripts/local-server.mjs serves the whole repo root, but they 404 in
// production, where only site/ exists. This copies the exact modules
// index.html needs into site/vendor/ before deploy, keeping the canonical
// source in scripts/lib and pages/lib as the single copy that ever gets
// hand-edited.
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
];

for (const [src, dest] of FILES) {
  const srcPath = path.join(ROOT, src);
  const destPath = path.join(ROOT, dest);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`build-site: ${src} -> ${dest}`);
}

console.log('build-site: done.');
