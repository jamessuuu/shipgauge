// Pure transformation: browser PerformanceResourceTiming entries -> the same
// NetworkRecord shape summarizeNetworkBytes() (bytes.mjs) already consumes.
// Used only by site/index.html (the standalone visitor self-test), because
// that page has no Playwright/CDP access — it can only see what the public
// Resource Timing API exposes. This module documents, and works around as
// best it can, the real gap between the two measurement paths:
//
//   - CDP (scripts/measure.mjs) reads Network.loadingFinished.encodedDataLength
//     directly from the browser process. No CORS involved. Always accurate.
//   - Resource Timing (this file) exposes `transferSize` only for
//     same-origin requests OR cross-origin requests whose response sent a
//     `Timing-Allow-Origin` header permitting it. transformers.js's runtime
//     (jsdelivr) and model weights (huggingface.co) are BOTH cross-origin
//     from a locally-served self-test page, so if either CDN omits that
//     header, transferSize reads 0 even though real bytes were transferred.
//
// This module never silently reports 0 as if it were a real measurement.
// Empirically (checked live against huggingface.co, 2026-08-15): HF's CDN
// sends no Timing-Allow-Origin, and the browser doesn't just hide
// transferSize for that case — decodedBodySize reads 0 too, while duration
// clearly shows real network time (hundreds of ms to multiple seconds for a
// model file). A zero-transferSize entry with real duration and
// decodedBodySize > 0 is flagged `approximate: true` and reported via the
// decoded-size fallback; a zero-transferSize, zero-decodedBodySize entry
// with real duration is flagged `opaque: true` and EXCLUDED from the byte
// total rather than counted as zero — the caller is expected to disclose
// the opaque count next to any total so nobody reads "0 B" as "nothing was
// transferred" when the true story is "we can't see it from here".

/**
 * @typedef {{
 *   name: string, transferSize?: number, decodedBodySize?: number,
 *   duration?: number, startTime?: number,
 * }} PerfResourceEntryLike
 */

const LIKELY_CACHE_HIT_MAX_DURATION_MS = 5;

/**
 * @param {PerfResourceEntryLike[]} entries
 * @param {number} [sinceStartTime] only include entries whose startTime >= this (perf.now()-relative)
 * @returns {{
 *   records: Array<{url:string,status:number,responseBodySize:number,responseHeadersSize:number,fromCache:boolean}>,
 *   approximateCount: number, approximateUrls: string[],
 *   opaqueCount: number, opaqueUrls: string[],
 * }}
 */
export function buildNetworkRecordsFromResourceTiming(entries, sinceStartTime = 0) {
  const records = [];
  const approximateUrls = [];
  const opaqueUrls = [];

  if (!Array.isArray(entries)) {
    return { records, approximateCount: 0, approximateUrls, opaqueCount: 0, opaqueUrls };
  }

  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    if (typeof entry.startTime === 'number' && entry.startTime < sinceStartTime) continue;

    const transferSize = Number.isFinite(entry.transferSize) ? entry.transferSize : 0;
    const decodedBodySize = Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : 0;
    const duration = Number.isFinite(entry.duration) ? entry.duration : 0;

    if (transferSize > 0) {
      records.push({ url: entry.name, status: 200, responseBodySize: transferSize, responseHeadersSize: 0, fromCache: false });
      continue;
    }

    // transferSize === 0: either a genuine cache hit, or a cross-origin
    // response the CDN didn't grant Timing-Allow-Origin to. Use duration as
    // the disambiguating heuristic (cache hits resolve near-instantly).
    const likelyCacheHit = duration < LIKELY_CACHE_HIT_MAX_DURATION_MS;
    if (likelyCacheHit) {
      records.push({ url: entry.name, status: 200, responseBodySize: 0, responseHeadersSize: 0, fromCache: true });
      continue;
    }

    // Not a cache hit (took real time) but transferSize is hidden.
    if (decodedBodySize > 0) {
      // Some browsers/CDNs still expose decodedBodySize without TAO — use
      // it as a labeled approximation (it under-counts true wire bytes for
      // compressed responses, since it's the POST-decompression size).
      approximateUrls.push(entry.name);
      records.push({ url: entry.name, status: 200, responseBodySize: decodedBodySize, responseHeadersSize: 0, fromCache: false });
    } else {
      // Fully opaque: real network time elapsed, but the spec zeroes every
      // size field for this cross-origin response with no TAO grant (this
      // is HuggingFace's CDN's actual behaviour, confirmed live). We do NOT
      // invent a number here, and we do NOT silently drop it either — the
      // caller must disclose opaqueCount next to any byte total.
      opaqueUrls.push(entry.name);
    }
  }

  return {
    records,
    approximateCount: approximateUrls.length,
    approximateUrls,
    opaqueCount: opaqueUrls.length,
    opaqueUrls,
  };
}
