// Pure decision logic for "did inference actually run on the execution
// provider we asked for". This is the crux of the study's honesty claim:
// silent CPU/WASM fallback while a demo's config nominally says 'webgpu' is
// exactly the number nobody checks. The raw signal is collected in the
// browser (scripts/../pages/lib/instrument.js monkey-patches
// GPUQueue.prototype.submit BEFORE transformers.js loads, so we count real
// GPU command-buffer submissions during the inference call — a runtime
// readback, not a re-statement of the config we passed in) and handed to
// this module as plain data for the actual determination, which is what
// makes the determination unit-testable without a browser.

/** @typedef {{
 *   requestedDevice: 'wasm'|'webgpu',
 *   gpuAdapterAvailable: boolean,
 *   gpuSubmitCount: number,
 *   consoleFallbackWarnings: string[],
 * }} ProviderSignals
 */

/** @typedef {{
 *   actualProvider: 'webgpu'|'wasm'|'wasm-silent-fallback'|'unavailable'|'anomalous',
 *   fallbackDetected: boolean,
 *   confidence: 'high'|'medium',
 *   reasoning: string,
 * }} ProviderVerdict
 */

const FALLBACK_LOG_PATTERNS = [
  /were not assigned to the preferred execution providers/i,
  /falling back to (wasm|cpu)/i,
  /webgpu.*not supported/i,
];

/**
 * Does any captured console line look like an ORT/transformers.js fallback
 * warning? Pure string matching, exported separately so the pattern list is
 * itself testable.
 * @param {string[]} lines
 * @returns {boolean}
 */
export function hasFallbackWarning(lines) {
  if (!Array.isArray(lines)) return false;
  return lines.some((line) => typeof line === 'string' && FALLBACK_LOG_PATTERNS.some((re) => re.test(line)));
}

/**
 * Derive the actual execution provider from runtime signals. Never trusts
 * the requested device alone — a request for 'webgpu' with zero GPU queue
 * submissions during inference is reported as a silent fallback regardless
 * of what the pipeline's own config said.
 * @param {ProviderSignals} signals
 * @returns {ProviderVerdict}
 */
export function deriveExecutionProvider(signals) {
  const {
    requestedDevice,
    gpuAdapterAvailable = false,
    gpuSubmitCount = 0,
    consoleFallbackWarnings = [],
  } = signals ?? {};

  const sawFallbackLog = hasFallbackWarning(consoleFallbackWarnings);

  if (requestedDevice === 'webgpu') {
    if (!gpuAdapterAvailable) {
      return {
        actualProvider: 'unavailable',
        fallbackDetected: true,
        confidence: 'high',
        reasoning:
          'webgpu was requested but navigator.gpu.requestAdapter() failed or returned null before the pipeline was even constructed — hardware/browser cannot run this row at all.',
      };
    }
    if (gpuSubmitCount > 0) {
      return {
        actualProvider: 'webgpu',
        fallbackDetected: sawFallbackLog, // GPU ran SOMETHING, but ORT may still have partially fallen back some ops to CPU
        confidence: sawFallbackLog ? 'medium' : 'high',
        reasoning: sawFallbackLog
          ? `GPUQueue.submit() was called ${gpuSubmitCount} time(s) during inference, confirming real GPU dispatch, but a console warning also indicates some graph nodes fell back to a non-preferred provider (partial fallback, not silent).`
          : `GPUQueue.submit() was called ${gpuSubmitCount} time(s) during inference — genuine GPU command-buffer dispatch observed, read back from the WebGPU runtime itself, not inferred from config.`,
      };
    }
    // webgpu requested, adapter exists, but zero GPU submits during inference:
    // this is the exact silent-fallback case the study exists to catch.
    return {
      actualProvider: 'wasm-silent-fallback',
      fallbackDetected: true,
      confidence: 'high',
      reasoning:
        'webgpu was requested and a GPU adapter WAS available, but zero GPUQueue.submit() calls were observed during the inference call — the pipeline silently ran on CPU/WASM despite device:"webgpu" in its own config. This is the failure mode config-only logging can never catch.',
    };
  }

  // requestedDevice === 'wasm'
  if (gpuSubmitCount > 0) {
    return {
      actualProvider: 'anomalous',
      fallbackDetected: false,
      confidence: 'medium',
      reasoning: `wasm was requested but ${gpuSubmitCount} GPUQueue.submit() call(s) were observed anyway — unexpected; worth a manual look before trusting this row.`,
    };
  }
  return {
    actualProvider: 'wasm',
    fallbackDetected: false,
    confidence: 'high',
    reasoning: 'wasm was requested and zero GPU queue submissions were observed, as expected.',
  };
}
