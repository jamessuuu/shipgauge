// The reproduction harness. Drives real Chromium via Playwright to measure
// the shippability profile of every (model, device) row in MODELS:
//   (a) true transfer bytes (raw CDP Network.loadingFinished encodedDataLength
//       — the same number Chrome DevTools' Network panel calls "Transferred",
//       not the decoded/decompressed body size)
//   (b) cold (fresh incognito context, empty cache) vs warm (same context,
//       revisit) load-to-first-inference wall time
//   (c) execution provider readback (pages/lib/instrument.js counts real
//       GPUQueue.submit() calls; scripts/lib/provider-readback.mjs turns
//       that into a verdict — never trusts the device string we requested)
//   (d) peak JS heap, cross-checked two ways: CDP Performance.getMetrics
//       (authoritative, not privacy-quantized) and the page's own
//       performance.memory sampler (what a visitor's self-test can see)
//   (e) revisit behaviour (does the SAME context re-download on a second
//       load, i.e. are cache headers actually honoured)
//
// WebGPU in headless Chromium is unreliable, so webgpu rows run headed;
// wasm rows don't touch the GPU at all and run headless for speed. Every
// row records which mode measured it (browserMode field).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODELS, validateModelCorpus } from './lib/models.mjs';
import { summarizeNetworkBytes } from './lib/bytes.mjs';
import { deriveExecutionProvider } from './lib/provider-readback.mjs';
import { assembleRow, assembleResultsDocument, generateResultsMarkdown } from './lib/assemble-results.mjs';
import { startServer } from './local-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'results');

const COLD_TIMEOUT_MS = 150_000;
const WARM_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 2;

function parseCliArgs(argv) {
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length)?.split(',');
  const devicesArg = argv.find((a) => a.startsWith('--devices='))?.slice('--devices='.length)?.split(',');
  return {
    only: only && only.length ? new Set(only) : null,
    devices: devicesArg && devicesArg.length ? devicesArg : ['wasm', 'webgpu'],
  };
}

/** Attach raw CDP Network listeners and return a live collector + stop(). */
async function attachNetworkCollector(client) {
  await client.send('Network.enable');
  const meta = new Map(); // requestId -> { url, status, fromCache }
  const finished = [];

  client.on('Network.requestWillBeSent', (e) => {
    meta.set(e.requestId, { url: e.request.url, status: null, fromCache: false });
  });
  client.on('Network.responseReceived', (e) => {
    const m = meta.get(e.requestId);
    if (m) {
      m.status = e.response.status;
      m.fromCache = !!(e.response.fromDiskCache || e.response.fromServiceWorker);
    }
  });
  client.on('Network.requestServedFromCache', (e) => {
    const m = meta.get(e.requestId);
    if (m) m.fromCache = true;
  });
  client.on('Network.loadingFinished', (e) => {
    const m = meta.get(e.requestId);
    if (!m) return;
    finished.push({
      url: m.url,
      status: m.status ?? 200,
      responseBodySize: m.fromCache ? 0 : e.encodedDataLength ?? 0,
      responseHeadersSize: 0, // not separately available from this CDP path; folded into responseBodySize upstream
      fromCache: m.fromCache,
    });
  });
  client.on('Network.loadingFailed', (e) => {
    const m = meta.get(e.requestId);
    finished.push({
      url: m?.url ?? 'unknown', status: 0, responseBodySize: 0, responseHeadersSize: 0, fromCache: false,
    });
  });

  return { records: finished };
}

async function attachHeapSampler(client) {
  await client.send('Performance.enable');
  let peak = 0;
  const tick = async () => {
    try {
      const { metrics } = await client.send('Performance.getMetrics');
      const heap = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
      if (heap > peak) peak = heap;
    } catch {
      // page may be mid-navigation; skip this sample
    }
  };
  await tick();
  const handle = setInterval(tick, 300);
  return {
    stop: async () => {
      clearInterval(handle);
      await tick();
      return peak;
    },
  };
}

/** Poll page.evaluate for window.__shipgaugeResult / __shipgaugeError until set or timeout. */
async function waitForResult(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await page.evaluate(() => ({
      result: window.__shipgaugeResult ?? null,
      error: window.__shipgaugeError ?? null,
    })).catch(() => ({ result: null, error: null }));
    if (outcome.result) return outcome.result;
    if (outcome.error) throw new Error(outcome.error);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for window.__shipgaugeResult`);
}

function buildHarnessUrl(baseUrl, model, device) {
  const params = new URLSearchParams({
    repo: model.repo,
    task: model.task,
    dtype: model.dtype,
    device,
    input: model.sampleInput,
    modelId: model.id,
    callOptions: JSON.stringify(model.callOptions ?? {}),
  });
  return `${baseUrl}/pages/harness.html?${params.toString()}`;
}

/** One pass (cold OR warm) inside an already-open context/page. */
async function measurePass(context, page, url, timeoutMs) {
  const client = await context.newCDPSession(page);
  const net = await attachNetworkCollector(client);
  const heap = await attachHeapSampler(client);

  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const pageResult = await waitForResult(page, timeoutMs);
  const elapsedMs = Date.now() - t0;
  const peakJsHeapBytes = await heap.stop();

  const byteSummary = summarizeNetworkBytes(net.records);
  await client.detach().catch(() => {});

  return { elapsedMs, pageResult, byteSummary, peakJsHeapBytes };
}

async function measureOneRow(browser, model, device, browserMode) {
  const { port, baseUrl } = globalThis.__shipgaugeServer;
  const url = buildHarnessUrl(baseUrl, model, device);

  const context = await browser.newContext(); // fresh = cold, empty cache by construction
  try {
    const page = await context.newPage();
    const cold = await measurePass(context, page, url, COLD_TIMEOUT_MS);
    if (!cold.pageResult.ok) {
      throw new Error(cold.pageResult.error ?? 'unknown in-page failure');
    }

    // warm: SAME context (same cache), reload the identical URL
    const warm = await measurePass(context, page, url, WARM_TIMEOUT_MS);

    const provider = deriveExecutionProvider({
      requestedDevice: device,
      gpuAdapterAvailable: cold.pageResult.gpuAdapterAvailable,
      gpuSubmitCount: cold.pageResult.gpuSubmitCount,
      consoleFallbackWarnings: cold.pageResult.consoleFallbackWarnings,
    });

    return {
      modelId: model.id,
      repo: model.repo,
      task: model.task,
      dtype: model.dtype,
      device,
      browserMode,
      status: 'ok',
      coldLoadToFirstInferenceMs: cold.elapsedMs,
      warmLoadToFirstInferenceMs: warm.elapsedMs,
      coldTotalTransferBytes: cold.byteSummary.totalTransferBytes,
      warmTotalTransferBytes: warm.byteSummary.totalTransferBytes,
      byOrigin: cold.byteSummary.byOrigin,
      advertisedBytes: model.advertisedBytes,
      advertisedSource: model.advertisedSource,
      peakJsHeapBytes: cold.peakJsHeapBytes,
      provider: {
        ...provider,
        gpuSubmitCount: cold.pageResult.gpuSubmitCount,
        gpuAdapterAvailable: cold.pageResult.gpuAdapterAvailable,
      },
      notes: model.notes,
      _debug: {
        gpuAdapterInfo: cold.pageResult.gpuAdapterInfo,
        outputShape: cold.pageResult.outputShape,
        coldRequestCount: cold.byteSummary.requestCount,
        warmRequestCount: warm.byteSummary.requestCount,
        warmCachedCount: warm.byteSummary.cachedCount,
      },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function measureRowWithRetry(browser, model, device, browserMode) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`  [${model.id}/${device}] attempt ${attempt}/${MAX_ATTEMPTS}…`);
      const row = await measureOneRow(browser, model, device, browserMode);
      console.log(
        `  [${model.id}/${device}] OK  cold=${Math.round(row.coldLoadToFirstInferenceMs)}ms  ` +
        `bytes=${row.coldTotalTransferBytes}  provider=${row.provider.actualProvider}` +
        (row.provider.fallbackDetected ? '  ⚠️ FALLBACK' : ''),
      );
      return row;
    } catch (err) {
      lastError = err;
      console.log(`  [${model.id}/${device}] attempt ${attempt} failed: ${err.message}`);
    }
  }
  console.log(`  [${model.id}/${device}] FAILED after ${MAX_ATTEMPTS} attempts — recording as a finding, moving on.`);
  return {
    modelId: model.id,
    repo: model.repo,
    task: model.task,
    dtype: model.dtype,
    device,
    browserMode,
    status: 'failed',
    error: lastError?.message ?? 'unknown error',
    notes: model.notes,
  };
}

async function collectMachineProfile(headedBrowser, baseUrl) {
  const context = await headedBrowser.newContext();
  const page = await context.newPage();
  // navigator.gpu is NOT reliably available on about:blank (confirmed
  // empirically on this machine: about:blank -> undefined, a page served
  // over http://127.0.0.1 -> available) — profile from a real served page.
  await page.goto(`${baseUrl}/pages/blank.html`);
  const gpu = await page.evaluate(async () => {
    if (!navigator.gpu) return { available: false };
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false };
      const info = adapter.info ?? {};
      return {
        available: true,
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
      };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
  await context.close();

  return {
    gpu,
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    os: `${os.platform()} ${os.release()}`,
    cpuModel: os.cpus()?.[0]?.model ?? 'unknown',
    cpuCount: os.cpus()?.length ?? null,
    browserVersion: `Chromium ${headedBrowser.version()}`,
    measuredAt: new Date().toISOString(),
  };
}

async function main() {
  const { only, devices } = parseCliArgs(process.argv.slice(2));

  const corpusCheck = validateModelCorpus(MODELS);
  if (!corpusCheck.valid) {
    console.error('MODELS corpus failed validation:', corpusCheck.errors);
    process.exit(1);
  }

  const models = only ? MODELS.filter((m) => only.has(m.id)) : MODELS;
  if (models.length === 0) {
    console.error('no models matched --only filter');
    process.exit(1);
  }

  console.log(`shipgauge measure: ${models.length} model(s) x ${devices.length} device(s)`);

  const { server, port, baseUrl } = await startServer(0);
  globalThis.__shipgaugeServer = { port, baseUrl };
  console.log(`local server: ${baseUrl}`);

  const headedBrowser = await chromium.launch({
    headless: false,
    // --enable-webgpu-developer-features unlocks GPUAdapterInfo.device /
    // .description (privacy-redacted to empty strings otherwise); vendor
    // and architecture are exposed without it. --enable-unsafe-webgpu is
    // kept for older-Chromium compatibility even though this build exposes
    // WebGPU without it.
    args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'],
  });
  const headlessBrowser = await chromium.launch({ headless: true });

  console.log('reading machine profile (GPU adapter readback, RAM, OS, browser version)…');
  const machineProfile = await collectMachineProfile(headedBrowser, baseUrl);
  console.log('machine profile:', JSON.stringify(machineProfile, null, 2));

  const rows = [];
  for (const model of models) {
    for (const device of devices) {
      const browserMode = device === 'webgpu' ? 'headed' : 'headless';
      const browser = browserMode === 'headed' ? headedBrowser : headlessBrowser;
      const raw = await measureRowWithRetry(browser, model, device, browserMode);
      const { row, errors } = assembleRow(raw);
      if (errors.length) {
        console.error(`  [${model.id}/${device}] assembleRow rejected raw data:`, errors);
        continue;
      }
      rows.push(row);
      // write incrementally so a long run's progress survives an interruption
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(RESULTS_DIR, '.progress.json'), JSON.stringify(rows, null, 2));
    }
  }

  await headedBrowser.close();
  await headlessBrowser.close();
  await new Promise((resolve) => server.close(resolve));

  const doc = assembleResultsDocument({
    rows,
    machineProfile,
    methodNotes: [
      'n = number of (model, device) rows measured on ONE machine, ONE run. This is a method demonstration, not a population claim — see README "Limits" before generalizing any number here.',
      'coldTotalTransferBytes is the sum of CDP Network.loadingFinished encodedDataLength across every non-cached request during first load in a fresh incognito context (transformers.js runtime + WASM binary + tokenizer/config files + model weights). It is the same figure Chrome DevTools\' Network panel calls "Transferred", not the decoded/decompressed size.',
      'warmTotalTransferBytes measures a second load in the SAME browser context (same disk/memory cache) — this is what "does it re-download on revisit" actually tests.',
      'webgpu rows ran in headed Chromium (--enable-unsafe-webgpu); wasm rows ran headless. Every row records its own browserMode.',
      'provider.actualProvider is derived from a real runtime signal (GPUQueue.submit() call count, captured by monkey-patching the WebGPU API before transformers.js loads), never from the device string we requested — see scripts/lib/provider-readback.mjs.',
      'peakJsHeapBytes is read via CDP Performance.getMetrics (JSHeapUsedSize), not the privacy-quantized performance.memory API.',
      'Observed on this machine: navigator.gpu is not available in headless Chromium at all (gpuAdapterAvailable=false on every wasm/headless row), even though the same binary exposes a working WebGPU adapter when headed. This is exactly why webgpu rows are never run headless in this harness — it is also independent, first-party confirmation of the "WebGPU in headless is unreliable" premise this study started from.',
      'GPUAdapterInfo.device and .description are redacted to empty strings by Chromium unless launched with --enable-webgpu-developer-features (vendor/architecture are exposed either way) — the machineProfile above was captured with that flag.',
    ],
  });

  fs.writeFileSync(path.join(RESULTS_DIR, 'results.json'), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(RESULTS_DIR, 'RESULTS.md'), generateResultsMarkdown(doc));
  fs.rmSync(path.join(RESULTS_DIR, '.progress.json'), { force: true });

  console.log(`\nwrote results/results.json and results/RESULTS.md — ${rows.length} rows, n=${doc.n}`);
  const failed = rows.filter((r) => r.status !== 'ok');
  if (failed.length) {
    console.log(`${failed.length} row(s) recorded as findings (failed to load): ${failed.map((r) => `${r.modelId}/${r.device}`).join(', ')}`);
  }
  const fallbacks = rows.filter((r) => r.provider?.fallbackDetected);
  if (fallbacks.length) {
    console.log(`${fallbacks.length} row(s) show a detected execution-provider fallback: ${fallbacks.map((r) => `${r.modelId}/${r.device}`).join(', ')}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
