// scripts/check-site-links.mjs
//
// Guards the outputDirectory boundary for what the pages LINK TO, the way
// scripts/build-site.mjs guards it for what they LOAD.
//
// The mechanism this exists to stop (2026-09-06 real-browser sweep; 15 dead
// links across assay, galley, shipgauge and carillon): site/*.html was written
// as if the whole repo were served, so footers and case-study cards linked to
// ../README.md, ../docs/SPEC.md, ../case-study/*/DIFF.md. Vercel uploads
// exactly the outputDirectory (site/), so on the deployed domain every one of
// those resolves to a Vercel 404. build-site.mjs had already fixed the same
// bug for src= and <link href=> (things the browser fetches on load) by
// vendoring them into site/vendor/, but nothing looked at <a href>, which the
// browser only follows on click, so the link half of the class survived the
// asset fix. Repo docs now link to their public GitHub URL instead.
//
// Rules, applied to every href/src/poster of every .html under the output
// directory (other external URLs are out of scope; this is a same-origin check):
//   escapes-output     the reference resolves above the output directory: it
//                      exists in the repo tree only, so it is a 404 live
//   missing-in-output  a relative reference to nothing in the output directory
//                      (cleanUrls variants foo -> foo.html and dir ->
//                      dir/index.html are accepted)
//   not-deployed       the file exists but .vercelignore keeps it off the deploy
//   github-path        a github.com/<owner>/<repo>/blob/<branch>/<path> link
//                      into THIS repo whose branch is not the default branch or
//                      whose path is not tracked in git, so it 404s on GitHub
//
// Usage: node scripts/check-site-links.mjs        (exit code 1 on any violation)
// Exports scanSite()/extractRefs() so the test suite runs the same rules in
// process, plus ensureSiteBuilt() so the scan sees what the deploy sees.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Per-repo facts. outputDir mirrors vercel.json's outputDirectory; build is
// the script that assembles it; github.branch is the repo's default branch,
// which is where /blob/ links must point to resolve.
export const SITE = Object.freeze({
  repoRoot: path.resolve(HERE, '..'),
  outputDir: 'site',
  build: 'scripts/build-site.mjs',
  ignoreFile: null,
  github: Object.freeze({ owner: 'jamessuuu', repo: 'shipgauge', branch: 'master' }),
});

export function ensureSiteBuilt(site = SITE) {
  if (!site.build) return;
  const result = spawnSync(process.execPath, [path.join(site.repoRoot, site.build)], {
    cwd: site.repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${site.build} failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
}

const toPosix = (p) => p.split(path.sep).join('/');

export function readIgnoreList(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

// The gitignore-style subset .vercelignore uses in these repos: a bare name
// matches that name at any depth, a trailing slash restricts it to
// directories, a name with an inner slash is anchored at the root.
export function isIgnored(relPosix, ignore) {
  const segs = relPosix.split('/');
  for (const entry of ignore) {
    const dirOnly = entry.endsWith('/');
    const name = dirOnly ? entry.slice(0, -1) : entry;
    if (name.includes('/')) {
      if (relPosix === name || relPosix.startsWith(`${name}/`)) return true;
    } else if (dirOnly) {
      if (segs.slice(0, -1).includes(name)) return true;
    } else if (segs.includes(name)) {
      return true;
    }
  }
  return false;
}

function walkHtml(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(full, out);
    else if (/\.html?$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const ENTITY = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };
const decodeEntities = (s) => s.replace(/&(?:amp|quot|#39|apos|lt|gt);/g, (m) => ENTITY[m]);

const TAG_RE = /<([a-zA-Z][\w:-]*)\b([^>]*)>/g;
// Leading whitespace is required so data-src / xlink:href do not match as
// src / href; the fragment-only xlink:href="#id" is skipped anyway.
const ATTR_RE = /(?:^|\s)(href|src|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

// Every href/src/poster attribute in the markup, as the browser would see it
// (entities decoded). Comments, script bodies and style bodies are dropped
// first: a commented-out link is not a link, and template strings inside an
// inline module are not attributes.
export function extractRefs(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, '$1$2');
  const refs = [];
  for (const tag of stripped.matchAll(TAG_RE)) {
    const name = tag[1].toLowerCase();
    for (const attr of tag[2].matchAll(ATTR_RE)) {
      const value = decodeEntities((attr[2] ?? attr[3] ?? attr[4] ?? '').trim());
      refs.push({ tag: name, attr: attr[1].toLowerCase(), value });
    }
  }
  return refs;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const GITHUB_BLOB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^?#]+)/;

export function classifyRef(value) {
  if (!value || value.startsWith('#')) return 'skip';
  if (value.startsWith('//')) return 'external';
  if (SCHEME_RE.test(value)) return /^https?:/i.test(value) ? 'external' : 'skip';
  return 'local';
}

function trackedFiles(repoRoot) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return new Set(result.stdout.split('\0').filter(Boolean));
}

function fileAt(p) {
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

// What Vercel would serve for a path under cleanUrls: the file itself, a
// directory's index.html, or the .html the extension was dropped from.
function resolveDeployed(target) {
  const direct = fileAt(target);
  if (direct) return direct;
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) return fileAt(path.join(target, 'index.html'));
  return fileAt(`${target}.html`);
}

function checkGithubLink(url, site, tracked) {
  const m = GITHUB_BLOB_RE.exec(url);
  if (!m) return null;
  const [, owner, repo, branch, rawPath] = m;
  // A link into some other repo cannot be verified from this tree.
  if (owner !== site.github.owner || repo !== site.github.repo) return null;
  if (branch !== site.github.branch) {
    return { rule: 'github-path', detail: `branch "${branch}" is not this repo's default branch "${site.github.branch}"` };
  }
  let filePath = rawPath;
  try {
    filePath = decodeURIComponent(rawPath);
  } catch {
    filePath = rawPath;
  }
  const present = tracked ? tracked.has(filePath) : existsSync(path.join(site.repoRoot, filePath));
  if (!present) {
    return { rule: 'github-path', detail: `${filePath} is not a tracked file in this repo, so GitHub 404s it` };
  }
  return null;
}

function checkRef(ref, { file, outputRoot, site, ignore, tracked }) {
  const kind = classifyRef(ref.value);
  if (kind === 'skip') return null;
  if (kind === 'external') return checkGithubLink(ref.value, site, tracked);
  const bare = ref.value.replace(/[?#].*$/, '');
  if (!bare) return null;
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    decoded = bare;
  }
  const target = decoded.startsWith('/')
    ? path.resolve(outputRoot, `.${decoded}`)
    : path.resolve(path.dirname(file), decoded);
  const rel = path.relative(outputRoot, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const where = toPosix(path.relative(site.repoRoot, target)) || '.';
    return {
      rule: 'escapes-output',
      detail: `resolves to ${where}, above ${site.outputDir}/, the only directory Vercel uploads`,
    };
  }
  const found = resolveDeployed(target);
  if (!found) {
    return {
      rule: 'missing-in-output',
      detail: `nothing at ${site.outputDir}/${toPosix(rel)} (nor its .html or index.html variant)`,
    };
  }
  const foundRel = toPosix(path.relative(site.repoRoot, found));
  if (isIgnored(foundRel, ignore)) {
    return { rule: 'not-deployed', detail: `${foundRel} is excluded by ${site.ignoreFile}` };
  }
  return null;
}

export function scanSite(site = SITE) {
  const outputRoot = path.resolve(site.repoRoot, site.outputDir);
  const ignore = readIgnoreList(site.ignoreFile ? path.join(site.repoRoot, site.ignoreFile) : null);
  const tracked = trackedFiles(site.repoRoot);
  const violations = [];
  for (const file of walkHtml(outputRoot)) {
    const page = toPosix(path.relative(site.repoRoot, file));
    if (isIgnored(page, ignore)) continue;
    const html = readFileSync(file, 'utf8');
    for (const ref of extractRefs(html)) {
      const violation = checkRef(ref, { file, outputRoot, site, ignore, tracked });
      if (violation) violations.push({ page, ...ref, ...violation });
    }
  }
  return violations;
}

export function main(site = SITE) {
  ensureSiteBuilt(site);
  const violations = scanSite(site);
  if (violations.length > 0) {
    console.error(`check-site-links: FAIL - ${violations.length} reference(s) would 404 on the deployed site`);
    for (const v of violations) {
      console.error(`  ${v.page}: <${v.tag} ${v.attr}="${v.value}"> [${v.rule}] ${v.detail}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `check-site-links: OK - every href/src/poster under ${site.outputDir}/ resolves inside the deployed output or to a tracked file on GitHub`,
  );
}

// CLI only when invoked directly, not when imported by the tests. Compared as
// file:// URLs, not raw path strings, so this works on Windows too.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
