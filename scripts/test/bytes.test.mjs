import { describe, it, expect } from 'vitest';
import {
  classifyOrigin,
  summarizeNetworkBytes,
  compareToAdvertised,
  formatBytes,
  evaluateRevisit,
} from '../lib/bytes.mjs';

describe('classifyOrigin', () => {
  it('classifies localhost as local', () => {
    expect(classifyOrigin('http://localhost:8080/pages/harness.html')).toBe('local');
    expect(classifyOrigin('http://127.0.0.1:8080/foo.js')).toBe('local');
  });

  it('classifies jsdelivr/unpkg as runtime-cdn', () => {
    expect(classifyOrigin('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0')).toBe('runtime-cdn');
    expect(classifyOrigin('https://unpkg.com/@huggingface/transformers')).toBe('runtime-cdn');
  });

  it('classifies huggingface.co / hf.co / cdn-lfs as model-cdn', () => {
    expect(classifyOrigin('https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx')).toBe('model-cdn');
    expect(classifyOrigin('https://cdn-lfs.huggingface.co/repos/abc/def')).toBe('model-cdn');
  });

  it('falls back to other for unrecognized hosts, and to other for malformed URLs', () => {
    expect(classifyOrigin('https://example.com/thing.js')).toBe('other');
    expect(classifyOrigin('not a url at all')).toBe('other');
    expect(classifyOrigin('')).toBe('other');
    expect(classifyOrigin(undefined)).toBe('other');
  });
});

describe('summarizeNetworkBytes', () => {
  it('sums encoded transfer bytes across origins and ignores cached requests for byte totals', () => {
    const records = [
      { url: 'http://localhost:8080/pages/harness.html', status: 200, responseBodySize: 2000, responseHeadersSize: 200, fromCache: false },
      { url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0', status: 200, responseBodySize: 1_500_000, responseHeadersSize: 300, fromCache: false },
      { url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx', status: 200, responseBodySize: 22_970_000, responseHeadersSize: 400, fromCache: false },
      { url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json', status: 200, responseBodySize: 700_000, responseHeadersSize: 250, fromCache: true },
    ];
    const summary = summarizeNetworkBytes(records);
    expect(summary.requestCount).toBe(4);
    expect(summary.cachedCount).toBe(1);
    expect(summary.cachedUrls).toEqual([records[3].url]);
    // cached request contributes 0 wire bytes
    expect(summary.totalTransferBytes).toBe(2000 + 1_500_000 + 22_970_000);
    expect(summary.byOrigin.local).toBe(2000);
    expect(summary.byOrigin['runtime-cdn']).toBe(1_500_000);
    expect(summary.byOrigin['model-cdn']).toBe(22_970_000);
  });

  it('counts 4xx/5xx responses as failed without throwing', () => {
    const records = [
      { url: 'https://huggingface.co/missing/model.onnx', status: 404, responseBodySize: 500, responseHeadersSize: 100, fromCache: false },
    ];
    const summary = summarizeNetworkBytes(records);
    expect(summary.failedCount).toBe(1);
    expect(summary.requestCount).toBe(1);
  });

  it('handles empty/non-array input defensively', () => {
    expect(summarizeNetworkBytes([]).totalTransferBytes).toBe(0);
    expect(summarizeNetworkBytes(null).totalTransferBytes).toBe(0);
    expect(summarizeNetworkBytes(undefined).requestCount).toBe(0);
  });

  it('skips malformed records rather than crashing', () => {
    const records = [null, {}, { url: 'https://huggingface.co/x', status: 200, responseBodySize: 100, responseHeadersSize: 10, fromCache: false }];
    const summary = summarizeNetworkBytes(records);
    expect(summary.requestCount).toBe(1);
    expect(summary.totalTransferBytes).toBe(100);
  });
});

describe('compareToAdvertised', () => {
  it('reports a positive delta when measured exceeds advertised', () => {
    const result = compareToAdvertised(140_380_000, 90_390_000);
    expect(result.deltaBytes).toBe(140_380_000 - 90_390_000);
    expect(result.measuredIsSmaller).toBe(false);
    expect(result.deltaPercent).toBeCloseTo(((140_380_000 - 90_390_000) / 90_390_000) * 100, 5);
  });

  it('reports a negative delta and measuredIsSmaller=true when measured is under advertised', () => {
    const result = compareToAdvertised(22_970_000, 90_390_000);
    expect(result.measuredIsSmaller).toBe(true);
    expect(result.deltaBytes).toBeLessThan(0);
  });

  it('returns NaN fields for invalid inputs instead of throwing', () => {
    expect(compareToAdvertised(NaN, 100).deltaBytes).toBeNaN();
    expect(compareToAdvertised(100, 0).deltaBytes).toBeNaN();
    expect(compareToAdvertised(100, -5).deltaBytes).toBeNaN();
  });
});

describe('formatBytes', () => {
  it('formats across unit ranges', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(22_970_000)).toBe('21.91 MB');
    expect(formatBytes(1_500_000_000)).toBe('1.40 GB');
  });

  it('preserves sign for negative values', () => {
    expect(formatBytes(-22_970_000)).toBe('-21.91 MB');
  });

  it('returns n/a for non-finite input', () => {
    expect(formatBytes(NaN)).toBe('n/a');
    expect(formatBytes(Infinity)).toBe('n/a');
  });
});

describe('evaluateRevisit', () => {
  it('honors cache when warm bytes drop by at least the threshold', () => {
    const result = evaluateRevisit(23_000_000, 0);
    expect(result.cacheHonored).toBe(true);
    expect(result.bytesSaved).toBe(23_000_000);
    expect(result.savingsRatio).toBe(1);
  });

  it('flags cache NOT honored when a revisit re-downloads nearly everything', () => {
    const result = evaluateRevisit(23_000_000, 22_500_000);
    expect(result.cacheHonored).toBe(false);
    expect(result.savingsRatio).toBeLessThan(0.5);
  });

  it('respects a custom savings threshold', () => {
    const result = evaluateRevisit(1000, 400, 0.5);
    expect(result.savingsRatio).toBeCloseTo(0.6, 5);
    expect(result.cacheHonored).toBe(true);
  });

  it('returns NaN/false defensively for invalid cold bytes', () => {
    expect(evaluateRevisit(0, 0).cacheHonored).toBe(false);
    expect(evaluateRevisit(NaN, 10).cacheHonored).toBe(false);
  });
});
