import { describe, it, expect } from 'vitest';
import { assembleRow, assembleResultsDocument, generateResultsMarkdown, sanitizeErrorForTable } from '../lib/assemble-results.mjs';

function okRawFixture(overrides = {}) {
  return {
    modelId: 'minilm-l6',
    repo: 'Xenova/all-MiniLM-L6-v2',
    task: 'feature-extraction',
    dtype: 'q8',
    device: 'webgpu',
    browserMode: 'headed',
    status: 'ok',
    coldLoadToFirstInferenceMs: 1234.5,
    warmLoadToFirstInferenceMs: 210.1,
    coldTotalTransferBytes: 23_500_000,
    warmTotalTransferBytes: 0,
    byOrigin: { local: 2000, 'runtime-cdn': 1_500_000, 'model-cdn': 22_000_000, other: 0 },
    advertisedBytes: 90_390_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32)',
    peakJsHeapBytes: 45_000_000,
    provider: {
      actualProvider: 'webgpu',
      fallbackDetected: false,
      confidence: 'high',
      reasoning: 'GPUQueue.submit() observed',
      gpuSubmitCount: 8,
      gpuAdapterAvailable: true,
    },
    notes: '',
    ...overrides,
  };
}

describe('assembleRow', () => {
  it('assembles a full ok row with derived deltaVsAdvertised and revisit fields', () => {
    const { row, errors } = assembleRow(okRawFixture());
    expect(errors).toEqual([]);
    expect(row.status).toBe('ok');
    expect(row.bytes.coldTotalTransferBytes).toBe(23_500_000);
    expect(row.bytes.deltaVsAdvertised.measuredIsSmaller).toBe(true);
    expect(row.bytes.revisit.cacheHonored).toBe(true);
    expect(row.provider.actualProvider).toBe('webgpu');
    expect(row.heap.peakJsHeapBytes).toBe(45_000_000);
  });

  it('rejects a raw measurement missing required fields', () => {
    const { row, errors } = assembleRow({ modelId: 'x' });
    expect(row).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('repo'))).toBe(true);
  });

  it('rejects an invalid device value', () => {
    const { row, errors } = assembleRow(okRawFixture({ device: 'cuda' }));
    expect(row).toBeNull();
    expect(errors.some((e) => e.includes('device'))).toBe(true);
  });

  it('produces a minimal row for a failed measurement without requiring timing/bytes fields', () => {
    const { row, errors } = assembleRow({
      modelId: 'distilgpt2',
      repo: 'Xenova/distilgpt2',
      task: 'text-generation',
      dtype: 'fp16',
      device: 'webgpu',
      browserMode: 'headed',
      status: 'failed',
      error: 'model load timed out after 60000ms',
    });
    expect(errors).toEqual([]);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/timed out/);
    expect(row.timing).toBeUndefined();
  });

  it('flags cache NOT honored when warm bytes are close to cold bytes', () => {
    const { row } = assembleRow(okRawFixture({ warmTotalTransferBytes: 23_400_000 }));
    expect(row.bytes.revisit.cacheHonored).toBe(false);
  });

  it('handles a missing advertisedBytes gracefully (no comparison, not a crash)', () => {
    const raw = okRawFixture();
    delete raw.advertisedBytes;
    const { row, errors } = assembleRow(raw);
    expect(errors).toEqual([]);
    expect(row.bytes.deltaVsAdvertised).toBeNull();
  });
});

describe('assembleResultsDocument', () => {
  it('wraps rows with machine profile, n, and an ISO timestamp', () => {
    const { row } = assembleRow(okRawFixture());
    const doc = assembleResultsDocument({
      rows: [row],
      machineProfile: { gpu: { vendor: 'AMD' }, ramGB: 32, os: 'Windows 11', browserVersion: 'Chrome 130' },
      methodNotes: ['n=1 machine'],
    });
    expect(doc.n).toBe(1);
    expect(doc.rows).toHaveLength(1);
    expect(() => new Date(doc.generatedAt).toISOString()).not.toThrow();
    expect(doc.machineProfile.ramGB).toBe(32);
  });

  it('throws on non-array rows or missing machine profile', () => {
    expect(() => assembleResultsDocument({ rows: null, machineProfile: {} })).toThrow();
    expect(() => assembleResultsDocument({ rows: [], machineProfile: null })).toThrow();
  });
});

describe('generateResultsMarkdown', () => {
  it('renders a markdown table with one row per measurement, including a fallback warning marker', () => {
    const { row: okRow } = assembleRow(okRawFixture({ modelId: 'gte-small' }));
    const { row: fallbackRow } = assembleRow(
      okRawFixture({
        modelId: 'bert-base-ner',
        device: 'webgpu',
        provider: {
          actualProvider: 'wasm-silent-fallback',
          fallbackDetected: true,
          confidence: 'high',
          reasoning: 'zero GPU submits observed',
          gpuSubmitCount: 0,
          gpuAdapterAvailable: true,
        },
      }),
    );
    const doc = assembleResultsDocument({
      rows: [okRow, fallbackRow],
      machineProfile: { gpu: { vendor: 'AMD', architecture: 'rdna3', device: '0x1234', description: 'AMD Radeon RX 9060 XT' }, ramGB: 32, os: 'Windows 11', browserVersion: 'Chrome 130' },
      methodNotes: ['n=2, single machine'],
    });
    const md = generateResultsMarkdown(doc);
    expect(md).toContain('# shipgauge — measured results');
    expect(md).toContain('n = 2 rows');
    expect(md).toContain('gte-small');
    expect(md).toContain('bert-base-ner');
    expect(md).toContain('wasm-silent-fallback');
    expect(md).toContain('⚠️ fallback');
    expect(md).toContain('AMD Radeon RX 9060 XT');
    expect(md).toContain('n=2, single machine');
  });

  it('renders failed rows without crashing on missing bytes/timing/provider', () => {
    const { row } = assembleRow({
      modelId: 'x', repo: 'y', task: 'z', dtype: 'q8', device: 'wasm', browserMode: 'headless',
      status: 'failed', error: 'download failed twice, giving up',
    });
    const doc = assembleResultsDocument({ rows: [row], machineProfile: {} });
    const md = generateResultsMarkdown(doc);
    expect(md).toContain('failed: download failed twice, giving up');
  });

  it('renders a failed row with a real multi-line ONNX Runtime error as exactly one table row, one line, correct column count', () => {
    const rawError = "Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: /mnt/vss/.../graph_utils.cc:30 ...\nfor node: /transformer/h.0/ln_1/Mul/SimplifiedLayerNormFusion/\n";
    const { row } = assembleRow({
      modelId: 'distilgpt2', repo: 'Xenova/distilgpt2', task: 'text-generation', dtype: 'fp16',
      device: 'wasm', browserMode: 'headless', status: 'failed', error: rawError,
    });
    const doc = assembleResultsDocument({ rows: [row], machineProfile: {} });
    const md = generateResultsMarkdown(doc);
    const tableLines = md.split('\n').filter((l) => l.startsWith('| distilgpt2'));
    expect(tableLines).toHaveLength(1); // the whole failed row must render as ONE markdown table line
    expect(tableLines[0]).not.toMatch(/\n/);
    // header has 10 columns -> 11 pipe characters; the failed row must match exactly
    const headerPipes = (md.match(/\| model \|.*\|\n/)[0].match(/\|/g) ?? []).length;
    const rowPipes = (tableLines[0].match(/\|/g) ?? []).length;
    expect(rowPipes).toBe(headerPipes);
  });

  it('throws when doc.rows is missing', () => {
    expect(() => generateResultsMarkdown({})).toThrow();
  });
});

describe('sanitizeErrorForTable', () => {
  it('collapses embedded newlines and repeated whitespace into single spaces', () => {
    expect(sanitizeErrorForTable('line one\nline two\n\nline three')).toBe('line one line two line three');
  });

  it('truncates very long messages with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const result = sanitizeErrorForTable(long);
    expect(result.length).toBeLessThan(300);
    expect(result.endsWith('…')).toBe(true);
  });

  it('leaves short single-line messages untouched (aside from trimming)', () => {
    expect(sanitizeErrorForTable('  timed out after 60000ms  ')).toBe('timed out after 60000ms');
  });

  it('handles missing/empty input defensively', () => {
    expect(sanitizeErrorForTable(undefined)).toBe('no details');
    expect(sanitizeErrorForTable('')).toBe('no details');
    expect(sanitizeErrorForTable(null)).toBe('no details');
  });
});
