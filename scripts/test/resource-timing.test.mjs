import { describe, it, expect } from 'vitest';
import { buildNetworkRecordsFromResourceTiming } from '../lib/resource-timing.mjs';
import { summarizeNetworkBytes } from '../lib/bytes.mjs';

describe('buildNetworkRecordsFromResourceTiming', () => {
  it('uses transferSize directly when the CDN exposes it (same-origin or Timing-Allow-Origin present)', () => {
    const entries = [
      { name: 'http://localhost/pages/harness.html', transferSize: 2000, decodedBodySize: 2000, duration: 3, startTime: 10 },
    ];
    const { records, approximateCount } = buildNetworkRecordsFromResourceTiming(entries, 0);
    expect(records).toEqual([{ url: entries[0].name, status: 200, responseBodySize: 2000, responseHeadersSize: 0, fromCache: false }]);
    expect(approximateCount).toBe(0);
  });

  it('treats near-instant zero-transferSize entries as cache hits, not opaque cross-origin transfers', () => {
    const entries = [
      { name: 'https://huggingface.co/model_quantized.onnx', transferSize: 0, decodedBodySize: 22_970_000, duration: 1.2, startTime: 10 },
    ];
    const { records, approximateCount } = buildNetworkRecordsFromResourceTiming(entries, 0);
    expect(records[0].fromCache).toBe(true);
    expect(records[0].responseBodySize).toBe(0);
    expect(approximateCount).toBe(0);
  });

  it('flags a slow zero-transferSize entry as an approximate (decoded-size) fallback when decodedBodySize IS available', () => {
    const entries = [
      { name: 'https://example-cdn-with-partial-tao.test/model.onnx', transferSize: 0, decodedBodySize: 22_970_000, duration: 850, startTime: 10 },
    ];
    const { records, approximateCount, approximateUrls, opaqueCount } = buildNetworkRecordsFromResourceTiming(entries, 0);
    expect(records[0].fromCache).toBe(false);
    expect(records[0].responseBodySize).toBe(22_970_000); // decoded fallback, not 0
    expect(approximateCount).toBe(1);
    expect(approximateUrls).toContain(entries[0].name);
    expect(opaqueCount).toBe(0);
  });

  it('classifies a real, slow, fully opaque cross-origin transfer (zero transferSize AND zero decodedBodySize) as opaque, not a silent zero-byte record', () => {
    // This is HuggingFace's CDN's real, confirmed-live behaviour (2026-08-15):
    // no Timing-Allow-Origin means BOTH transferSize and decodedBodySize read
    // 0, even though duration proves a real multi-hundred-ms/multi-second
    // transfer happened. Silently treating this as a cache hit or a 0-byte
    // record would misreport "nothing was transferred" when the opposite is true.
    const entries = [
      { name: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', transferSize: 0, decodedBodySize: 0, duration: 3912, startTime: 10 },
    ];
    const { records, opaqueCount, opaqueUrls } = buildNetworkRecordsFromResourceTiming(entries, 0);
    expect(records).toHaveLength(0); // not added as a fabricated zero-byte record
    expect(opaqueCount).toBe(1);
    expect(opaqueUrls).toContain(entries[0].name);
  });

  it('treats a fast zero-transferSize, zero-decodedBodySize entry as a genuine (tiny) cache hit, not opaque', () => {
    const entries = [
      { name: 'https://example.com/tiny-204', transferSize: 0, decodedBodySize: 0, duration: 0.5, startTime: 10 },
    ];
    // duration < 5ms threshold -> classified as a (zero-byte) cache hit, which is the honest call here
    const { records, opaqueCount } = buildNetworkRecordsFromResourceTiming(entries, 0);
    expect(records[0].fromCache).toBe(true);
    expect(opaqueCount).toBe(0);
  });

  it('filters entries that started before the requested window', () => {
    const entries = [
      { name: 'https://old-resource', transferSize: 500, decodedBodySize: 500, duration: 3, startTime: 5 },
      { name: 'https://new-resource', transferSize: 700, decodedBodySize: 700, duration: 3, startTime: 15 },
    ];
    const { records } = buildNetworkRecordsFromResourceTiming(entries, 10);
    expect(records).toHaveLength(1);
    expect(records[0].url).toBe('https://new-resource');
  });

  it('handles non-array / malformed input defensively', () => {
    expect(buildNetworkRecordsFromResourceTiming(null).records).toEqual([]);
    expect(buildNetworkRecordsFromResourceTiming([null, {}, undefined]).records).toEqual([]);
  });

  it('feeds cleanly into summarizeNetworkBytes (integration between the two pure modules)', () => {
    const entries = [
      { name: 'http://localhost/pages/harness.html', transferSize: 2000, decodedBodySize: 2000, duration: 3, startTime: 0 },
      { name: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0', transferSize: 1_500_000, decodedBodySize: 1_500_000, duration: 40, startTime: 0 },
      { name: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', transferSize: 0, decodedBodySize: 22_970_000, duration: 900, startTime: 0 },
    ];
    const { records, approximateCount } = buildNetworkRecordsFromResourceTiming(entries, 0);
    const summary = summarizeNetworkBytes(records);
    expect(summary.totalTransferBytes).toBe(2000 + 1_500_000 + 22_970_000);
    expect(approximateCount).toBe(1);
  });
});
