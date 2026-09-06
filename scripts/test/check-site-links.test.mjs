import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SITE, classifyRef, ensureSiteBuilt, extractRefs, scanSite } from '../check-site-links.mjs';

// Vercel uploads exactly site/ (vercel.json outputDirectory). Any reference
// in site/index.html that resolves outside it, or to nothing inside it, is a
// 404 on the deployed domain no matter how well it resolves in the repo
// tree. The 2026-09-06 sweep found the README link (../README.md) dead on
// the live page; scripts/build-site.mjs had fixed the same class for the
// module imports but nothing looked at <a href>.
describe('deployed site links (outputDirectory boundary)', () => {
  beforeAll(() => {
    ensureSiteBuilt(SITE);
  });

  it('every href/src/poster under site/ resolves inside the deployed output or to a tracked file on GitHub', () => {
    const violations = scanSite(SITE);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('the real page links the README by its GitHub URL on the default branch (master), never by ../', () => {
    const html = readFileSync(path.join(SITE.repoRoot, SITE.outputDir, 'index.html'), 'utf8');
    const hrefs = extractRefs(html).filter((r) => r.attr === 'href').map((r) => r.value);
    expect(hrefs.some((h) => h.startsWith('../'))).toBe(false);
    expect(hrefs).toContain(`https://github.com/${SITE.github.owner}/${SITE.github.repo}/blob/${SITE.github.branch}/README.md`);
    expect(SITE.github.branch).toBe('master');
  });
});

describe('extractRefs / classifyRef', () => {
  it('sees href, src and poster on any tag and skips comments, script bodies and style bodies', () => {
    const html = `
      <!-- <a href="../commented-out.md">not a link</a> -->
      <a href="a.html?x=1&amp;y=2">a</a>
      <script type="module">import { MODELS } from './vendor/scripts/lib/models.mjs'; const s = '<a href="../x.md">';</script>
      <style>select { background-image: url("data:image/svg+xml,%3Csvg%3E"); }</style>
      <img src="b.png">
    `;
    expect(extractRefs(html)).toEqual([
      { tag: 'a', attr: 'href', value: 'a.html?x=1&y=2' },
      { tag: 'img', attr: 'src', value: 'b.png' },
    ]);
  });

  it('separates fragments and non-http schemes (skip) from external URLs and local paths', () => {
    expect(classifyRef('#top')).toBe('skip');
    expect(classifyRef('mailto:x@y.z')).toBe('skip');
    expect(classifyRef('https://agentjames.vercel.app')).toBe('external');
    expect(classifyRef('../README.md')).toBe('local');
  });
});

describe('the rules bite on a synthetic site', () => {
  let root;
  let site;
  const gh = `https://github.com/${SITE.github.owner}/${SITE.github.repo}/blob`;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'shipgauge-links-'));
    mkdirSync(path.join(root, 'site', 'sub'), { recursive: true });
    writeFileSync(path.join(root, 'README.md'), '# exists in the repo, not in site/');
    writeFileSync(path.join(root, 'site', 'ok.html'), '<p>ok</p>');
    writeFileSync(path.join(root, 'site', 'sub', 'index.html'), '<p>sub</p>');
    writeFileSync(path.join(root, 'site', 'hidden.html'), '<p>excluded by ignore</p>');
    writeFileSync(path.join(root, '.vercelignore'), 'hidden.html\n');
    writeFileSync(
      path.join(root, 'site', 'index.html'),
      [
        '<a href="../README.md">escapes</a>',
        '<a href="nope.html">missing</a>',
        '<a href="hidden.html">not deployed</a>',
        '<a href="ok">clean-url ok</a>',
        '<a href="sub">dir index ok</a>',
        '<a href="/ok.html?x=1#frag">root-relative ok</a>',
        '<a href="#top">fragment</a>',
        '<a href="https://example.com/anything">external, out of scope</a>',
        `<a href="${gh}/${SITE.github.branch}/does-not-exist.md">gh missing</a>`,
        `<a href="${gh}/main/README.md">gh wrong branch (this repo deploys from master)</a>`,
        `<a href="${gh}/${SITE.github.branch}/README.md">gh ok</a>`,
      ].join('\n'),
    );
    site = { ...SITE, repoRoot: root, outputDir: 'site', build: null, ignoreFile: '.vercelignore' };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags exactly the four broken shapes and nothing else', () => {
    const violations = scanSite(site);
    const byValue = Object.fromEntries(violations.map((v) => [v.value, v.rule]));
    expect(byValue['../README.md']).toBe('escapes-output');
    expect(byValue['nope.html']).toBe('missing-in-output');
    expect(byValue['hidden.html']).toBe('not-deployed');
    expect(byValue[`${gh}/${SITE.github.branch}/does-not-exist.md`]).toBe('github-path');
    expect(byValue[`${gh}/main/README.md`]).toBe('github-path');
    expect(violations).toHaveLength(5);
  });
});
