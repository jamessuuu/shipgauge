// Pure parsing/assembly logic for network transfer accounting.
// The harness (scripts/measure.mjs) collects raw per-request records from
// Playwright's request.sizes() + response.fromServiceWorker()/headers();
// everything in this file is pure transformation over plain data so it can
// be unit tested without a browser.

/** @typedef {{
 *   url: string,
 *   status: number,
 *   responseBodySize: number,
 *   responseHeadersSize: number,
 *   fromCache: boolean,
 *   resourceType?: string,
 * }} NetworkRecord
 */

/**
 * Classify a request URL into an origin bucket for the shippability
 * breakdown (local harness scaffolding vs runtime CDN vs model-weight CDN).
 * @param {string} url
 * @returns {'local'|'runtime-cdn'|'model-cdn'|'other'}
 */
export function classifyOrigin(url) {
  if (typeof url !== 'string' || url.length === 0) return 'other';
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'other';
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return 'local';
  if (host.includes('jsdelivr.net') || host.includes('unpkg.com') || host.includes('cdn.skypack.dev')) {
    return 'runtime-cdn';
  }
  if (host.includes('huggingface.co') || host.includes('hf.co') || host.includes('cdn-lfs')) {
    return 'model-cdn';
  }
  return 'other';
}

/**
 * Sum true wire bytes (encoded/compressed transfer size, never decoded body
 * size) across a set of network records, broken down by origin bucket.
 * A request served entirely from the browser's HTTP cache contributes 0 to
 * totalTransferBytes (it did not go over the wire) but is still counted in
 * cachedCount / cachedUrls so revisit behaviour is visible.
 * @param {NetworkRecord[]} records
 * @returns {{
 *   totalTransferBytes: number,
 *   totalHeaderBytes: number,
 *   byOrigin: Record<string, number>,
 *   requestCount: number,
 *   cachedCount: number,
 *   cachedUrls: string[],
 *   failedCount: number,
 * }}
 */
export function summarizeNetworkBytes(records) {
  const summary = {
    totalTransferBytes: 0,
    totalHeaderBytes: 0,
    byOrigin: { local: 0, 'runtime-cdn': 0, 'model-cdn': 0, other: 0 },
    requestCount: 0,
    cachedCount: 0,
    cachedUrls: /** @type {string[]} */ ([]),
    failedCount: 0,
  };
  if (!Array.isArray(records)) return summary;

  for (const rec of records) {
    if (!rec || typeof rec.url !== 'string') continue;
    summary.requestCount += 1;

    if (rec.status && rec.status >= 400) {
      summary.failedCount += 1;
    }

    if (rec.fromCache) {
      summary.cachedCount += 1;
      summary.cachedUrls.push(rec.url);
      continue; // served from cache: zero wire bytes, by definition
    }

    const body = Number.isFinite(rec.responseBodySize) ? rec.responseBodySize : 0;
    const headers = Number.isFinite(rec.responseHeadersSize) ? rec.responseHeadersSize : 0;
    summary.totalTransferBytes += body;
    summary.totalHeaderBytes += headers;

    const bucket = classifyOrigin(rec.url);
    summary.byOrigin[bucket] = (summary.byOrigin[bucket] ?? 0) + body;
  }

  return summary;
}

/**
 * Compare a measured byte total against a model's advertised/reference size.
 * Positive delta means we transferred MORE than advertised.
 * @param {number} measuredBytes
 * @param {number} advertisedBytes
 * @returns {{ deltaBytes: number, deltaPercent: number, measuredIsSmaller: boolean }}
 */
export function compareToAdvertised(measuredBytes, advertisedBytes) {
  if (!Number.isFinite(measuredBytes) || !Number.isFinite(advertisedBytes) || advertisedBytes <= 0) {
    return { deltaBytes: NaN, deltaPercent: NaN, measuredIsSmaller: false };
  }
  const deltaBytes = measuredBytes - advertisedBytes;
  const deltaPercent = (deltaBytes / advertisedBytes) * 100;
  return { deltaBytes, deltaPercent, measuredIsSmaller: deltaBytes < 0 };
}

/**
 * Human-readable byte formatter for RESULTS.md / console output.
 * @param {number} bytes
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 2) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes === 0) return '0 B';
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(abs) / Math.log(1024)), units.length - 1);
  const value = abs / 1024 ** exp;
  return `${sign}${value.toFixed(exp === 0 ? 0 : decimals)} ${units[exp]}`;
}

/**
 * Determine whether a revisit (second load, same context) honoured caching:
 * true if the revisit's total transfer bytes dropped by at least
 * `minSavingsRatio` relative to the cold load. This is the pure decision
 * function behind "does it re-download in full on revisit".
 * @param {number} coldBytes
 * @param {number} warmBytes
 * @param {number} [minSavingsRatio] fraction of cold bytes that must be saved to count as "honoured"
 * @returns {{ cacheHonored: boolean, bytesSaved: number, savingsRatio: number }}
 */
export function evaluateRevisit(coldBytes, warmBytes, minSavingsRatio = 0.5) {
  if (!Number.isFinite(coldBytes) || !Number.isFinite(warmBytes) || coldBytes <= 0) {
    return { cacheHonored: false, bytesSaved: NaN, savingsRatio: NaN };
  }
  const bytesSaved = coldBytes - warmBytes;
  const savingsRatio = bytesSaved / coldBytes;
  return { cacheHonored: savingsRatio >= minSavingsRatio, bytesSaved, savingsRatio };
}
