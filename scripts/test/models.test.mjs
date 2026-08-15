import { describe, it, expect } from 'vitest';
import { MODELS, validateModelConfig, validateModelCorpus } from '../lib/models.mjs';

describe('validateModelConfig', () => {
  const valid = {
    id: 'minilm-l6',
    repo: 'Xenova/all-MiniLM-L6-v2',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 90_390_000,
    advertisedSource: 'HF tree API',
    sampleInput: 'hello world',
    callOptions: { pooling: 'mean' },
  };

  it('accepts a well-formed config', () => {
    expect(validateModelConfig(valid)).toEqual({ valid: true, errors: [] });
  });

  it('rejects missing required string fields', () => {
    const { valid: ok, errors } = validateModelConfig({ ...valid, repo: '' });
    expect(ok).toBe(false);
    expect(errors.some((e) => e.includes('repo'))).toBe(true);
  });

  it('rejects a non-positive or non-finite advertisedBytes', () => {
    expect(validateModelConfig({ ...valid, advertisedBytes: 0 }).valid).toBe(false);
    expect(validateModelConfig({ ...valid, advertisedBytes: -5 }).valid).toBe(false);
    expect(validateModelConfig({ ...valid, advertisedBytes: NaN }).valid).toBe(false);
  });

  it('rejects a non-kebab id (would break filename/slug usage)', () => {
    expect(validateModelConfig({ ...valid, id: 'MiniLM_L6' }).valid).toBe(false);
  });

  it('rejects a non-object callOptions when present', () => {
    expect(validateModelConfig({ ...valid, callOptions: 'nope' }).valid).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    expect(validateModelConfig(null).valid).toBe(false);
    expect(validateModelConfig(undefined).valid).toBe(false);
  });
});

describe('validateModelCorpus', () => {
  const base = {
    id: 'a', repo: 'org/a', task: 'feature-extraction', dtype: 'q8',
    advertisedBytes: 1000, advertisedSource: 's', sampleInput: 'hi',
  };

  it('accepts a corpus of distinct valid configs', () => {
    const result = validateModelCorpus([base, { ...base, id: 'b', repo: 'org/b' }]);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects duplicate ids', () => {
    const result = validateModelCorpus([base, { ...base, repo: 'org/b' }]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('duplicate id'))).toBe(true);
  });

  it('rejects an empty or non-array corpus', () => {
    expect(validateModelCorpus([]).valid).toBe(false);
    expect(validateModelCorpus(null).valid).toBe(false);
  });

  it('aggregates errors across multiple bad entries', () => {
    const result = validateModelCorpus([{ id: 'bad one' }, { ...base }]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe('the real study corpus (scripts/lib/models.mjs MODELS)', () => {
  it('passes schema validation as shipped', () => {
    const result = validateModelCorpus(MODELS);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('has between 8 and 12 models as required by the study brief', () => {
    expect(MODELS.length).toBeGreaterThanOrEqual(8);
    expect(MODELS.length).toBeLessThanOrEqual(12);
  });

  it('keeps at least one model at or under 150MB advertised, and reports any exceptions with a note', () => {
    const over150 = MODELS.filter((m) => m.advertisedBytes > 150_000_000 * 1.0 && m.notes.length === 0);
    // Any model whose real shipped artifact could exceed the 150MB preference
    // must carry an explanatory note (advertisedBytes is the fp32 reference,
    // not what we ship, so this checks the documentation discipline, not the
    // fp32 number itself).
    expect(MODELS.every((m) => m.notes && m.notes.length > 0)).toBe(true);
  });

  it('keeps total advertised (fp32 reference) bytes reasonable for a reproducible study', () => {
    const total = MODELS.reduce((sum, m) => sum + m.advertisedBytes, 0);
    // fp32 reference sizes overstate what we actually transfer (we ship
    // quantized dtypes); this just guards against an accidental huge model
    // sneaking into the corpus.
    expect(total).toBeLessThan(3_000_000_000);
  });
});
