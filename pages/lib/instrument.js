// Shared client-side instrumentation. Loaded by BOTH:
//   - pages/harness.html  (driven by scripts/measure.mjs via Playwright)
//   - site/index.html     (the standalone self-test a visitor runs themselves)
// so the two never drift: whatever the reproducible harness measures is
// exactly what a visitor's own self-test measures, by construction.
//
// Everything here runs IN the page. No Playwright/Node API is used or
// assumed, so site/index.html works with nothing but a static file host.

/**
 * Install the WebGPU submission counter. MUST be called synchronously,
 * before any code (including a dynamically-imported transformers.js) has a
 * chance to create a GPU device and submit work — otherwise submissions
 * could be missed. This is the runtime readback: we are not asking the
 * pipeline what device it thinks it used, we are counting real
 * GPUQueue.submit() calls, which is the WebGPU spec's actual "do work on
 * the GPU now" entry point.
 * @returns {{ getCount: () => number, available: boolean }}
 */
export function installGpuSubmitCounter() {
  let count = 0;
  const available = typeof GPUQueue !== 'undefined' && !!GPUQueue.prototype.submit;
  if (available) {
    const original = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function patchedSubmit(...args) {
      count += 1;
      return original.apply(this, args);
    };
  }
  return { getCount: () => count, available };
}

/**
 * Install a console interceptor that keeps a plain array of warn/error
 * lines, so provider-fallback log lines survive even on the standalone
 * self-test page (no Playwright console listener exists there).
 * @returns {{ getLines: () => string[] }}
 */
export function installConsoleCapture() {
  const lines = [];
  const wrap = (orig) => (...args) => {
    try {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    } catch {
      lines.push(String(args[0]));
    }
    return orig.apply(console, args);
  };
  console.warn = wrap(console.warn.bind(console));
  console.error = wrap(console.error.bind(console));
  return { getLines: () => lines };
}

/**
 * Read back real WebGPU adapter info (vendor/architecture/device/description)
 * without assuming any particular model will run — this is machine-profile
 * data, independent of whether a given row requests webgpu or wasm.
 * @returns {Promise<{ available: boolean, adapterInfo: object|null, requestDeviceOk: boolean }>}
 */
export async function readGpuAdapterInfo() {
  if (!navigator.gpu) return { available: false, adapterInfo: null, requestDeviceOk: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { available: false, adapterInfo: null, requestDeviceOk: false };
    // adapter.info is the current (synchronous) spec property; the older
    // requestAdapterInfo() method has been removed from Chrome and Firefox.
    const info = adapter.info ?? {};
    let requestDeviceOk = false;
    try {
      await adapter.requestDevice();
      requestDeviceOk = true;
    } catch {
      requestDeviceOk = false;
    }
    return {
      available: true,
      adapterInfo: {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
      },
      requestDeviceOk,
    };
  } catch {
    return { available: false, adapterInfo: null, requestDeviceOk: false };
  }
}

/**
 * Start polling performance.memory.usedJSHeapSize (Chromium-only, non
 * standard, privacy-quantized but good enough for a relative "did this
 * allocate under pressure" signal) and track the observed peak.
 * @param {number} intervalMs
 * @returns {{ stop: () => number, samples: () => number }}
 */
export function startHeapPeakSampler(intervalMs = 75) {
  let peak = 0;
  let sampleCount = 0;
  const supported = typeof performance !== 'undefined' && !!performance.memory;
  const tick = () => {
    if (supported && performance.memory.usedJSHeapSize > peak) {
      peak = performance.memory.usedJSHeapSize;
    }
    sampleCount += 1;
  };
  tick();
  const handle = supported ? setInterval(tick, intervalMs) : null;
  return {
    stop: () => {
      if (handle) clearInterval(handle);
      tick();
      return peak;
    },
    samples: () => sampleCount,
  };
}

/**
 * Parse the deterministic query-string configuration both harness pages
 * accept: repo, task, dtype, device, input, callOptions (JSON), advertisedBytes.
 * @param {string} search location.search
 * @returns {{ repo: string, task: string, dtype: string, device: 'wasm'|'webgpu', input: string, callOptions: object, modelId: string }}
 */
export function parseRunConfig(search) {
  const params = new URLSearchParams(search);
  const required = ['repo', 'task', 'dtype', 'device', 'input', 'modelId'];
  for (const key of required) {
    if (!params.get(key)) throw new Error(`missing required query param: ${key}`);
  }
  let callOptions = {};
  const rawOpts = params.get('callOptions');
  if (rawOpts) {
    try {
      callOptions = JSON.parse(rawOpts);
    } catch (e) {
      throw new Error(`callOptions is not valid JSON: ${e.message}`);
    }
  }
  return {
    repo: params.get('repo'),
    task: params.get('task'),
    dtype: params.get('dtype'),
    device: params.get('device'),
    input: params.get('input'),
    modelId: params.get('modelId'),
    callOptions,
  };
}

/**
 * Run the full profiled inference for one (model, device) configuration.
 * Returns a plain-data result object — no DOM, no functions — safe to
 * JSON.stringify and safe to read via page.evaluate() from Playwright.
 * @param {{ repo: string, task: string, dtype: string, device: string, input: string, callOptions: object }} config
 * @param {(msg: string) => void} [onStatus] optional UI status callback (used by site/index.html)
 */
export async function runProfile(config, onStatus = () => {}) {
  const gpuCounter = installGpuSubmitCounter();
  const consoleCapture = installConsoleCapture();
  const heapSampler = startHeapPeakSampler();

  onStatus('reading GPU adapter info…');
  const gpu = await readGpuAdapterInfo();

  onStatus(`loading transformers.js runtime + ${config.repo} (dtype=${config.dtype}, device=${config.device})…`);
  const t0 = performance.now();

  let pipelineFn, output, errorMessage = null;
  try {
    const { pipeline, env } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'
    );
    env.allowRemoteModels = true;

    pipelineFn = await pipeline(config.task, config.repo, {
      dtype: config.dtype,
      device: config.device,
      progress_callback: (p) => onStatus(`loading: ${p.file ?? ''} ${p.status ?? ''} ${p.progress ? Math.round(p.progress) + '%' : ''}`),
    });

    onStatus('running first inference…');
    output = await pipelineFn(config.input, config.callOptions ?? {});
  } catch (err) {
    errorMessage = err?.message ?? String(err);
  }

  const t1 = performance.now();
  const peakJsHeapBytes = heapSampler.stop();

  // A cheap, honest sanity signal that *something* real came back, without
  // dumping full tensor contents into results.json.
  let outputShape = null;
  if (output != null) {
    if (Array.isArray(output)) outputShape = `array(len=${output.length})`;
    else if (output?.dims) outputShape = `tensor(dims=${JSON.stringify(output.dims)})`;
    else if (typeof output === 'object') outputShape = `object(keys=${Object.keys(output).join(',')})`;
    else outputShape = typeof output;
  }

  return {
    ok: errorMessage === null,
    error: errorMessage,
    elapsedMs: t1 - t0,
    outputShape,
    gpuSubmitCount: gpuCounter.getCount(),
    gpuAdapterAvailable: gpu.available,
    gpuAdapterInfo: gpu.adapterInfo,
    gpuRequestDeviceOk: gpu.requestDeviceOk,
    consoleFallbackWarnings: consoleCapture.getLines(),
    peakJsHeapBytes: peakJsHeapBytes || null,
    heapSamplingSupported: typeof performance !== 'undefined' && !!performance.memory,
  };
}
