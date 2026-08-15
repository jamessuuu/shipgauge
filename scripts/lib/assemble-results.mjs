// Pure assembly logic: turns raw per-row measurements (collected by
// scripts/measure.mjs from a real Playwright + browser run) into the final
// results.json row shape, and turns a finished results document into the
// RESULTS.md markdown table. No I/O, no browser — fully unit-testable.

import { compareToAdvertised, evaluateRevisit, formatBytes } from './bytes.mjs';

const MAX_TABLE_ERROR_LEN = 160;

/**
 * Collapse a (possibly multi-line, possibly very long) error message into a
 * single markdown-table-safe line. GFM tables break on embedded newlines,
 * and a raw ONNX Runtime stack-style message can run to hundreds of
 * characters — this keeps the table readable while the full, untruncated
 * error still lives in results.json (this function is only used for the
 * .md rendering, never for the JSON row itself).
 * @param {string} message
 * @returns {string}
 */
export function sanitizeErrorForTable(message) {
  if (typeof message !== 'string' || message.length === 0) return 'no details';
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_TABLE_ERROR_LEN) return collapsed;
  return `${collapsed.slice(0, MAX_TABLE_ERROR_LEN - 1)}…`;
}

/** @typedef {{
 *   modelId: string, repo: string, task: string, dtype: string,
 *   device: 'wasm'|'webgpu', browserMode: 'headed'|'headless',
 *   coldLoadToFirstInferenceMs: number, warmLoadToFirstInferenceMs: number,
 *   coldTotalTransferBytes: number, warmTotalTransferBytes: number,
 *   byOrigin: Record<string, number>,
 *   advertisedBytes: number, advertisedSource: string,
 *   peakJsHeapBytes: number,
 *   provider: import('./provider-readback.mjs').ProviderVerdict & { gpuSubmitCount: number, gpuAdapterAvailable: boolean },
 *   status: 'ok'|'failed'|'skipped', error?: string|null, notes?: string,
 * }} RawRowMeasurement
 */

const REQUIRED_RAW_FIELDS = [
  'modelId', 'repo', 'task', 'dtype', 'device', 'browserMode',
  'status',
];

/**
 * @param {Partial<RawRowMeasurement>} raw
 * @returns {{ row: object|null, errors: string[] }}
 */
export function assembleRow(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { row: null, errors: ['raw measurement must be an object'] };
  }
  for (const field of REQUIRED_RAW_FIELDS) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === '') {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (raw.status && !['ok', 'failed', 'skipped'].includes(raw.status)) {
    errors.push(`status must be one of ok|failed|skipped, got: ${raw.status}`);
  }
  if (raw.device && !['wasm', 'webgpu'].includes(raw.device)) {
    errors.push(`device must be one of wasm|webgpu, got: ${raw.device}`);
  }
  if (errors.length > 0) return { row: null, errors };

  if (raw.status !== 'ok') {
    return {
      row: {
        modelId: raw.modelId,
        repo: raw.repo,
        task: raw.task,
        dtype: raw.dtype,
        device: raw.device,
        browserMode: raw.browserMode,
        status: raw.status,
        error: raw.error ?? null,
        notes: raw.notes ?? '',
      },
      errors: [],
    };
  }

  const cold = Number(raw.coldTotalTransferBytes);
  const warm = Number(raw.warmTotalTransferBytes);
  const advertised = Number(raw.advertisedBytes);

  const deltaVsAdvertised = Number.isFinite(advertised) ? compareToAdvertised(cold, advertised) : null;
  const revisit = Number.isFinite(cold) && Number.isFinite(warm) ? evaluateRevisit(cold, warm) : null;

  const row = {
    modelId: raw.modelId,
    repo: raw.repo,
    task: raw.task,
    dtype: raw.dtype,
    device: raw.device,
    browserMode: raw.browserMode,
    status: 'ok',
    timing: {
      coldLoadToFirstInferenceMs: raw.coldLoadToFirstInferenceMs ?? null,
      warmLoadToFirstInferenceMs: raw.warmLoadToFirstInferenceMs ?? null,
    },
    bytes: {
      coldTotalTransferBytes: Number.isFinite(cold) ? cold : null,
      warmTotalTransferBytes: Number.isFinite(warm) ? warm : null,
      coldTotalTransferHuman: Number.isFinite(cold) ? formatBytes(cold) : 'n/a',
      byOrigin: raw.byOrigin ?? {},
      advertisedBytes: Number.isFinite(advertised) ? advertised : null,
      advertisedSource: raw.advertisedSource ?? '',
      deltaVsAdvertised,
      revisit,
    },
    heap: {
      peakJsHeapBytes: raw.peakJsHeapBytes ?? null,
      peakJsHeapHuman: Number.isFinite(raw.peakJsHeapBytes) ? formatBytes(raw.peakJsHeapBytes) : 'n/a',
    },
    provider: raw.provider ?? null,
    notes: raw.notes ?? '',
  };

  return { row, errors: [] };
}

/**
 * @param {{ rows: object[], machineProfile: object, methodNotes?: string[] }} input
 * @returns {object}
 */
export function assembleResultsDocument({ rows, machineProfile, methodNotes = [] }) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!machineProfile || typeof machineProfile !== 'object') {
    throw new TypeError('machineProfile must be an object');
  }
  return {
    study: 'shipgauge — browser-ML shippability study',
    generatedAt: new Date().toISOString(),
    n: rows.length,
    machineProfile,
    methodNotes,
    rows,
  };
}

/**
 * @param {object} doc result of assembleResultsDocument
 * @returns {string} markdown
 */
export function generateResultsMarkdown(doc) {
  if (!doc || !Array.isArray(doc.rows)) throw new TypeError('doc.rows must be an array');

  const lines = [];
  lines.push('# shipgauge — measured results');
  lines.push('');
  lines.push(`Generated: ${doc.generatedAt}`);
  lines.push('');
  lines.push(`**n = ${doc.n} rows** (model x device configurations measured on ONE machine — see README for what n means here).`);
  lines.push('');
  lines.push('## Machine profile');
  lines.push('');
  const mp = doc.machineProfile ?? {};
  lines.push(`- GPU: ${mp.gpu?.vendor ?? 'n/a'} / ${mp.gpu?.architecture ?? 'n/a'} / ${mp.gpu?.device ?? 'n/a'} — "${mp.gpu?.description ?? 'n/a'}"`);
  lines.push(`- RAM: ${mp.ramGB ?? 'n/a'} GB`);
  lines.push(`- OS: ${mp.os ?? 'n/a'}`);
  lines.push(`- Browser: ${mp.browserVersion ?? 'n/a'}`);
  lines.push('');
  lines.push('## Rows');
  lines.push('');
  lines.push('| model | task | device | mode | provider (readback) | cold bytes | vs advertised | cold->infer | cache honored | peak heap |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');

  for (const row of doc.rows) {
    if (row.status !== 'ok') {
      lines.push(
        `| ${row.modelId} | ${row.task} | ${row.device} | ${row.browserMode} | *${row.status}: ${sanitizeErrorForTable(row.error)}* | — | — | — | — | — |`,
      );
      continue;
    }
    const provider = row.provider?.actualProvider ?? 'unknown';
    const fallbackFlag = row.provider?.fallbackDetected ? ' ⚠️ fallback' : '';
    const coldBytes = row.bytes?.coldTotalTransferHuman ?? 'n/a';
    const delta = row.bytes?.deltaVsAdvertised;
    const deltaStr = delta && Number.isFinite(delta.deltaPercent) ? `${delta.deltaPercent >= 0 ? '+' : ''}${delta.deltaPercent.toFixed(1)}%` : 'n/a';
    const coldMs = row.timing?.coldLoadToFirstInferenceMs != null ? `${Math.round(row.timing.coldLoadToFirstInferenceMs)}ms` : 'n/a';
    const cacheHonored = row.bytes?.revisit ? (row.bytes.revisit.cacheHonored ? 'yes' : 'NO') : 'n/a';
    const heap = row.heap?.peakJsHeapHuman ?? 'n/a';
    lines.push(
      `| ${row.modelId} | ${row.task} | ${row.device} | ${row.browserMode} | ${provider}${fallbackFlag} | ${coldBytes} | ${deltaStr} | ${coldMs} | ${cacheHonored} | ${heap} |`,
    );
  }

  lines.push('');
  if (doc.methodNotes?.length) {
    lines.push('## Method notes');
    lines.push('');
    for (const note of doc.methodNotes) lines.push(`- ${note}`);
    lines.push('');
  }

  return lines.join('\n');
}
