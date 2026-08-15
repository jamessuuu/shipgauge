import { describe, it, expect } from 'vitest';
import { hasFallbackWarning, deriveExecutionProvider } from '../lib/provider-readback.mjs';

describe('hasFallbackWarning', () => {
  it('matches the real ONNX Runtime fallback warning text', () => {
    expect(
      hasFallbackWarning([
        'Some nodes were not assigned to the preferred execution providers which may or may not have a negative impact on performance.',
      ]),
    ).toBe(true);
  });

  it('matches "falling back to wasm/cpu" phrasing case-insensitively', () => {
    expect(hasFallbackWarning(['Falling back to WASM execution provider'])).toBe(true);
    expect(hasFallbackWarning(['falling back to cpu for op Gather'])).toBe(true);
  });

  it('returns false for unrelated console noise', () => {
    expect(hasFallbackWarning(['Model loaded successfully', 'Downloaded 22.97MB'])).toBe(false);
  });

  it('handles empty/non-array input defensively', () => {
    expect(hasFallbackWarning([])).toBe(false);
    expect(hasFallbackWarning(null)).toBe(false);
    expect(hasFallbackWarning(undefined)).toBe(false);
  });
});

describe('deriveExecutionProvider', () => {
  it('confirms webgpu when requested, adapter available, and GPU submits observed', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'webgpu',
      gpuAdapterAvailable: true,
      gpuSubmitCount: 12,
      consoleFallbackWarnings: [],
    });
    expect(verdict.actualProvider).toBe('webgpu');
    expect(verdict.fallbackDetected).toBe(false);
    expect(verdict.confidence).toBe('high');
  });

  it('flags SILENT fallback when webgpu requested, adapter available, but zero GPU submits — the core catch', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'webgpu',
      gpuAdapterAvailable: true,
      gpuSubmitCount: 0,
      consoleFallbackWarnings: [],
    });
    expect(verdict.actualProvider).toBe('wasm-silent-fallback');
    expect(verdict.fallbackDetected).toBe(true);
    expect(verdict.confidence).toBe('high');
    expect(verdict.reasoning).toMatch(/silently ran on CPU\/WASM/i);
  });

  it('reports unavailable (high confidence) when webgpu requested but no adapter at all', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'webgpu',
      gpuAdapterAvailable: false,
      gpuSubmitCount: 0,
      consoleFallbackWarnings: [],
    });
    expect(verdict.actualProvider).toBe('unavailable');
    expect(verdict.fallbackDetected).toBe(true);
  });

  it('downgrades confidence to medium when webgpu ran but a partial-fallback console warning was also seen', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'webgpu',
      gpuAdapterAvailable: true,
      gpuSubmitCount: 5,
      consoleFallbackWarnings: ['Some nodes were not assigned to the preferred execution providers which may or may not have a negative impact on performance.'],
    });
    expect(verdict.actualProvider).toBe('webgpu');
    expect(verdict.fallbackDetected).toBe(true);
    expect(verdict.confidence).toBe('medium');
  });

  it('confirms wasm as expected when requested and zero GPU submits observed', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'wasm',
      gpuAdapterAvailable: true,
      gpuSubmitCount: 0,
      consoleFallbackWarnings: [],
    });
    expect(verdict.actualProvider).toBe('wasm');
    expect(verdict.fallbackDetected).toBe(false);
    expect(verdict.confidence).toBe('high');
  });

  it('flags an anomaly when wasm was requested but GPU submits occurred anyway', () => {
    const verdict = deriveExecutionProvider({
      requestedDevice: 'wasm',
      gpuAdapterAvailable: true,
      gpuSubmitCount: 3,
      consoleFallbackWarnings: [],
    });
    expect(verdict.actualProvider).toBe('anomalous');
    expect(verdict.fallbackDetected).toBe(false);
    expect(verdict.confidence).toBe('medium');
  });

  it('handles missing/undefined signals object without throwing', () => {
    const verdict = deriveExecutionProvider(undefined);
    // requestedDevice undefined falls through to the wasm branch (not 'webgpu')
    expect(verdict.actualProvider).toBe('wasm');
  });
});
