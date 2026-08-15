// Model corpus for the shippability study.
//
// Selection method: 10 models commonly recommended in transformers.js docs/
// examples/community posts, covering embedding, classification, NER, and
// tiny generation. Sizes below were pulled from the HuggingFace Hub tree API
// (`/api/models/{repo}/tree/main/onnx`) on 2026-08-15 — this is the same
// mechanism the "advertisedBytes" field cites, so the advertised-vs-measured
// comparison is against a real, checkable number, not a vibe.
//
// Budget: prefer <=150MB per model; one deliberate exception (distilgpt2)
// is kept because its own quantized artifact is *larger* than its fp16
// artifact on HF — a real shippability trap worth reporting, not hidden.
// Total ONNX weight footprint across all 10 rows is ~690MB, well under the
// ~1.5GB study cap.

/** @typedef {{
 *   id: string,
 *   repo: string,
 *   task: string,
 *   dtype: string,
 *   advertisedBytes: number,
 *   advertisedSource: string,
 *   sampleInput: string,
 *   callOptions: Record<string, unknown>,
 *   notes: string,
 * }} ModelConfig
 */

/** @type {ModelConfig[]} */
export const MODELS = [
  {
    id: 'minilm-l6',
    repo: 'Xenova/all-MiniLM-L6-v2',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 90_390_000,
    advertisedSource:
      'HF tree API onnx/model.onnx (fp32) = 90.39MB — the figure most blog posts/READMEs casually cite for "the MiniLM-L6 embedding model", even though transformers.js ships the quantized file (onnx/model_quantized.onnx = 22.97MB) by default.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'mean', normalize: true },
    notes:
      'The single most-cited transformers.js example model (used in the official README and most tutorials).',
  },
  {
    id: 'minilm-l12',
    repo: 'Xenova/all-MiniLM-L12-v2',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 133_090_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 133.09MB.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'mean', normalize: true },
    notes: 'Deeper sibling of MiniLM-L6; common upgrade pick for embedding quality.',
  },
  {
    id: 'bge-small',
    repo: 'Xenova/bge-small-en-v1.5',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 133_090_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 133.09MB.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'cls', normalize: true },
    notes: 'BAAI general embedding model; MTEB-leaderboard staple, widely recommended for RAG.',
  },
  {
    id: 'gte-small',
    repo: 'Xenova/gte-small',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 133_090_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 133.09MB.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'mean', normalize: true },
    notes: 'Alibaba general text embedding; same architecture shape as bge-small (both MiniLM-family sized).',
  },
  {
    id: 'distilbert-sst2',
    repo: 'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    task: 'sentiment-analysis',
    dtype: 'q8',
    advertisedBytes: 267_960_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 267.96MB.',
    sampleInput: 'I absolutely loved this movie, it was fantastic!',
    callOptions: {},
    notes: 'The transformers.js README\'s own sentiment-analysis example model.',
  },
  {
    id: 'albert-base-v2',
    repo: 'Xenova/albert-base-v2',
    task: 'feature-extraction',
    dtype: 'uint8',
    advertisedBytes: 45_270_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 45.27MB.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'mean', normalize: true },
    notes:
      'Deliberately uses dtype uint8 (11.76MB) instead of the default "q8" quantized file, because for this repo onnx/model_quantized.onnx (40.22MB) is nearly 4x LARGER than onnx/model_uint8.onnx (11.76MB) for the same nominal "quantized" concept — a shippability trap in its own right, reported as a finding.',
  },
  {
    id: 'bert-base-ner',
    repo: 'Xenova/bert-base-NER',
    task: 'token-classification',
    dtype: 'q8',
    advertisedBytes: 431_170_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 431.17MB.',
    sampleInput: 'My name is Sarah and I live in London.',
    callOptions: {},
    notes: 'Full BERT-base backbone; the largest of the four encoder-classification rows (right at the ~150MB per-model ceiling).',
  },
  {
    id: 'paraphrase-multilingual-minilm-l12',
    repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    task: 'feature-extraction',
    dtype: 'q8',
    advertisedBytes: 470_270_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 470.27MB.',
    sampleInput: 'The quick brown fox jumps over the lazy dog.',
    callOptions: { pooling: 'mean', normalize: true },
    notes:
      'Cross-check row: this exact model was measured by the showcase-program P7 model card at "140.38MB, ~24.25s cold load" (see showcase-program/SELECTION-2.md, 2026-08-09). Re-measuring it here is a deliberate internal-consistency check on this harness, not a coincidence.',
  },
  {
    id: 'lamini-flan-t5-77m',
    repo: 'Xenova/LaMini-Flan-T5-77M',
    task: 'text2text-generation',
    dtype: 'q8',
    advertisedBytes: 232_780_000,
    advertisedSource: 'HF tree API onnx/decoder_model_merged.onnx (fp32) = 232.78MB (largest single fp32 component).',
    sampleInput: 'What is the capital of France?',
    callOptions: { max_new_tokens: 20, do_sample: false },
    notes:
      'Seq2seq generation loads TWO onnx graphs (encoder_model + decoder_model_merged); advertisedBytes and measured bytes both reflect that two-file reality.',
  },
  {
    id: 'distilgpt2',
    repo: 'Xenova/distilgpt2',
    task: 'text-generation',
    dtype: 'fp16',
    advertisedBytes: 327_830_000,
    advertisedSource: 'HF tree API onnx/model.onnx (fp32) = 327.83MB.',
    sampleInput: 'The future of artificial intelligence is',
    callOptions: { max_new_tokens: 20, do_sample: false },
    notes:
      'Deliberately uses dtype fp16 (164.00MB) instead of "q8"/int8/uint8, because for this repo the quantized/int8/uint8 files (~236-238MB) are all LARGER than fp16 (164.00MB) — quantization made the artifact bigger, not smaller. Reported as a finding, not swept under the rug; this is the one row over the 150MB per-model preference, kept on purpose.',
  },
];

/**
 * Validate a single model config has the fields the harness and results
 * assembler require. Pure — no I/O — so it is unit-testable without a
 * browser or network access.
 * @param {Partial<ModelConfig>} cfg
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateModelConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') {
    return { valid: false, errors: ['config must be an object'] };
  }
  const requiredStrings = ['id', 'repo', 'task', 'dtype', 'sampleInput', 'advertisedSource'];
  for (const key of requiredStrings) {
    if (typeof cfg[key] !== 'string' || cfg[key].length === 0) {
      errors.push(`missing or empty required string field: ${key}`);
    }
  }
  if (typeof cfg.advertisedBytes !== 'number' || !Number.isFinite(cfg.advertisedBytes) || cfg.advertisedBytes <= 0) {
    errors.push('advertisedBytes must be a positive finite number');
  }
  if (cfg.callOptions !== undefined && (typeof cfg.callOptions !== 'object' || cfg.callOptions === null)) {
    errors.push('callOptions must be an object when present');
  }
  if (cfg.id && !/^[a-z0-9-]+$/.test(cfg.id)) {
    errors.push(`id "${cfg.id}" must be lowercase-kebab (used as a filename/slug)`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validate the whole corpus: every entry individually valid, plus no
 * duplicate ids (duplicate ids would silently overwrite result rows).
 * @param {Partial<ModelConfig>[]} models
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateModelCorpus(models) {
  const errors = [];
  if (!Array.isArray(models) || models.length === 0) {
    return { valid: false, errors: ['corpus must be a non-empty array'] };
  }
  const seenIds = new Set();
  for (const cfg of models) {
    const result = validateModelConfig(cfg);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `[${cfg?.id ?? '?'}] ${e}`));
    }
    if (cfg?.id) {
      if (seenIds.has(cfg.id)) errors.push(`duplicate id: ${cfg.id}`);
      seenIds.add(cfg.id);
    }
  }
  return { valid: errors.length === 0, errors };
}
