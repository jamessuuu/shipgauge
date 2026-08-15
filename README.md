# shipgauge

**A browser-ML shippability study.** Every browser-ML demo publishes speed.
None publishes whether it *ships*: true bytes over the wire, cold load on a
cold cache, whether inference actually ran on the GPU it claims to use, or
whether the thing allocates itself into a crash under memory pressure.

This is a **method plus n measured configurations, with n printed** — not a
leaderboard, not a population claim. One machine, one GPU, one browser
version, 20 (model × device) rows, reproducible from a clean checkout.

## What it measures

For every `(model, device)` row, a real Chromium browser (via Playwright)
loads the model through [transformers.js](https://github.com/huggingface/transformers.js)
and reports five things, all read back from the runtime — never assumed from
config:

1. **True total transfer bytes** — the actual encoded/compressed bytes that
   crossed the wire (runtime + WASM binary + tokenizer/config + model
   weights), read via the Chrome DevTools Protocol's
   `Network.loadingFinished.encodedDataLength` — the same number Chrome
   DevTools' own Network panel calls "Transferred". Cache disabled by
   construction: every "cold" row runs in a brand-new incognito context.
2. **Cold vs warm load-to-first-inference time** — cold = fresh context,
   empty cache; warm = second load, same context, same cache.
3. **Execution-provider readback** — did inference actually run on WebGPU,
   or silently fall back to WASM/CPU? Silent fallback is the number nobody
   checks. This harness monkey-patches `GPUQueue.prototype.submit` *before*
   transformers.js ever loads, and counts real GPU command-buffer
   submissions during inference. A row that requested `device:"webgpu"` with
   zero submits is reported as `wasm-silent-fallback`, regardless of what
   the pipeline's own config says. See `scripts/lib/provider-readback.mjs`.
4. **Peak JS heap** — via CDP `Performance.getMetrics` (`JSHeapUsedSize`),
   not the privacy-quantized `performance.memory` API.
5. **Revisit behaviour** — does a second load in the same browser context
   honour cache headers, or silently re-download everything?

## Prior art, credited up front

Before building this, we checked whether "WASM beats WebGPU at batch=1 for
small-model browser inference" was already established. It is — confirmed by
three independent sources:

- [gpuweb/gpuweb Discussion #5292](https://github.com/gpuweb/gpuweb/discussions/5292)
  (Aug 2025): ~80ms WASM vs ~1100ms WebGPU for EfficientNet via
  onnxruntime-web, plus a cited HF benchmark showing WASM 6× faster.
- [SitePoint, "WebGPU vs WebASM: Browser Inference Benchmarks"](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/):
  measures all-MiniLM-L6-v2 at WASM 8–12ms vs WebGPU 15–25ms for short
  single-sentence input, names GPU dispatch overhead as the mechanism, and
  confirms the reversal at batch=32 on the same model (WASM 12,587ms vs
  WebGPU 384.8ms).
- [arXiv 2604.02344](https://arxiv.org/abs/2604.02344), "Characterizing
  WebGPU Dispatch Overhead for LLM Inference..." (Maczan, 2026): quantifies
  the mechanism directly — 24–71µs per-dispatch WebGPU API overhead, ~95µs
  total per operation, confirming per-operation overhead dominates at
  batch=1 across 4 GPU vendors, 2 native backends, 3 browsers.

**This study does not claim to have discovered that effect.** What it
contributes is real, hardware-attributed, dated measurements for a specific
corpus on a specific machine — see [Findings](#findings) below, and note
that our "cold load" timing bundles network download + session creation +
first inference (a shippability number), which is a related but *different*
measurement than the pure post-warm inference-latency benchmarks the sources
above report. Full detail and the correction this triggered in an unrelated
internal doc: see the git log for `showcase-program/SELECTION-2.md`.

## Reproduce it

```
npm install
npx playwright install chromium
npm test                 # vitest — harness parsing/assembly logic, 67 tests
npm run measure           # the real thing: launches Chromium, measures all 10 models x 2 devices
```

`npm run measure` accepts `--only=modelId1,modelId2` and `--devices=wasm,webgpu`
to run a subset (see `scripts/lib/models.mjs` for ids). A full run takes
roughly 5–6 minutes on a home broadband connection and downloads real model
weights from HuggingFace's CDN and the transformers.js runtime from jsdelivr
— it is not mocked, sandboxed, or replayed.

Results land in `results/results.json` (full data + machine profile) and
`results/RESULTS.md` (generated table). A visitor who wants to run the same
profile on **their own** machine can open `site/index.html` (served over
http, not `file://` — see Limits) — it reuses the exact same instrumentation
module (`pages/lib/instrument.js`) as the reproducible harness, so the two
never drift.

## The model corpus (n=10 models, 20 rows)

Ten models commonly recommended in transformers.js docs/examples, covering
embedding, sentiment classification, NER, and tiny generation — full detail
including the *why* behind each dtype choice is in `scripts/lib/models.mjs`:

| model | task | dtype used | why this dtype |
|---|---|---|---|
| Xenova/all-MiniLM-L6-v2 | feature-extraction | q8 | the single most-cited transformers.js example |
| Xenova/all-MiniLM-L12-v2 | feature-extraction | q8 | deeper MiniLM sibling |
| Xenova/bge-small-en-v1.5 | feature-extraction | q8 | MTEB staple, common RAG pick |
| Xenova/gte-small | feature-extraction | q8 | same size class as bge-small |
| Xenova/distilbert-base-uncased-finetuned-sst-2-english | sentiment-analysis | q8 | the README's own sentiment example |
| Xenova/albert-base-v2 | feature-extraction | **uint8** | its own "quantized" file is 4x LARGER than uint8 — a trap in itself |
| Xenova/bert-base-NER | token-classification | q8 | largest encoder row, right at the 150MB preference ceiling |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | feature-extraction | q8 | cross-check: independently measured before at 140.38MB (see SELECTION-2.md) — this run measured 133.89MB (see Findings) |
| Xenova/LaMini-Flan-T5-77M | text2text-generation | q8 | tiny seq2seq, loads 2 ONNX graphs |
| Xenova/distilgpt2 | text-generation | **fp16** | its "quantized"/int8/uint8 files (~236MB) are all LARGER than fp16 (164MB) |

Budget: preferred ≤150MB/model; one deliberate exception (distilgpt2, kept
because the size anomaly itself is the finding). Total ONNX weight footprint
across all 10 models: ~690MB, comfortably under the ~1.5GB study cap.

## Findings

From the actual measured run committed in `results/results.json`
(2026-08-15, n=20 rows: 10 models × 2 devices; **n=19 succeeded, n=1
recorded as a failure finding**). Machine: AMD Ryzen 7 9700X, AMD Radeon RX
9060 XT (RDNA4), 31.1GB RAM, Windows 11, Chromium 151.0.7922.34.

**1. The fp32 number everyone casually cites overstates real transfer weight
by 48–74%.** Every one of the 10 models measured 48.3–73.5% *smaller* than
its own fp32 reference file (sourced from the HuggingFace tree API, not a
guess). all-MiniLM-L6-v2 — the single most-copied transformers.js example —
is commonly cited at "90MB"; this harness measured **26.81MB** true wire
bytes (runtime + tokenizer + weights combined) for the exact code most
tutorials ship. distilgpt2 (fp16) had the smallest gap at -48.3%, still
transferring 161.78MB against a 327.83MB fp32 reference.

**2. WebGPU cold-load-to-first-inference was slower than WASM in 8 of 9
head-to-head model pairs** (average +5.5%, range +1.1% to +12.4%), with one
clean exception — paraphrase-multilingual-MiniLM-L12 ran 9.1% *faster* on
WebGPU. This is directionally consistent with the established batch=1
dispatch-overhead prior art above, but is **not the same measurement**: ours
bundles network download + WebGPU session/pipeline creation + first
inference (a shippability number), while the cited sources isolate
post-warm inference latency. Read it as "small-model browser-ML demos don't
get a free cold-start win from requesting WebGPU" — not as a replication of
the cited 8–12ms-vs-15–25ms figures.

**3. A real, reproducible engine bug: distilgpt2 + fp16 + wasm fails to even
create an ONNX Runtime session.** Not a timeout, not a slow load — a graph
partitioning error (`SimplifiedLayerNormFusion` referencing a missing
`InsertedPrecisionFreeCast` node) thrown on both retry attempts. The exact
same model+dtype succeeds cleanly on WebGPU (161.78MB, ~32.6s cold, GPU
execution independently confirmed). This closes a loop from model selection:
distilgpt2's "quantized"/int8/uint8 files are *larger* than fp16 on
HuggingFace (finding #4 below), which pushes a size-conscious developer
toward fp16 — exactly the dtype that breaks on WASM for this model. You would
only find this by actually trying it in a browser, which is the whole point
of this study.

**4. Quantization sometimes makes the file bigger, not smaller** — confirmed
independent of the browser run, sourced directly from HuggingFace's file
listing: distilgpt2's `model_quantized.onnx`/`model_int8.onnx`/`model_uint8.onnx`
are all ~236–238MB, all *larger* than `model_fp16.onnx` at 164.00MB.
albert-base-v2 shows the same shape at smaller scale: its
`model_quantized.onnx` is 40.22MB, nearly 4× its own `model_uint8.onnx` at
11.76MB. "Quantized" is not a size guarantee; it has to be measured per file.

**5. Zero silent execution-provider fallbacks detected — on this GPU.**
Every one of the 10 successful WebGPU rows showed real `GPUQueue.submit()`
activity (confirmed via runtime readback, not config). This is a genuine
negative result on an AMD RDNA4 GPU with this Chromium build, not proof the
failure mode doesn't exist — the gpuweb #5292 report that motivated this
whole check was filed on different hardware. The instrumentation is real and
running (verified across all 20 rows); this corpus, on this machine, simply
didn't trigger it. A GPU-vendor sweep is exactly the kind of follow-up this
single-machine study can't do (see Limits).

**6. Cache was honoured on every successful row (19/19).** Warm reload
transferred effectively 0 bytes for every model on both jsdelivr (runtime)
and huggingface.co (weights). No re-download-on-revisit bug found in this
corpus.

**7. (Self-test tooling, not the main harness) HuggingFace's CDN sends no
`Timing-Allow-Origin`.** Discovered building `site/index.html`: the public
Resource Timing API zeroes out *both* `transferSize` and `decodedBodySize`
for HF's cross-origin responses — not just transfer size, as the API's
common usage would suggest. The self-test page now detects and discloses
this ("size unknown — opaque") instead of silently showing 0 bytes; the main
harness is unaffected because CDP has no such blind spot.

## Limits (read before generalizing anything above)

- **n=1 machine.** Every number above came from one AMD Ryzen 7 9700X / RX
  9060 XT (RDNA4) / Windows 11 / Chromium 151 box. No Intel or NVIDIA GPU,
  no Apple Silicon, no Linux, no Firefox or Safari, no mobile. Different
  hardware will show different — possibly very different — provider-fallback
  and timing behaviour; finding #5 above is the clearest example of why that
  matters.
- **n=1 run per row.** No repeated trials, no variance/confidence interval.
  Cold-load timing in particular is bandwidth- and CDN-latency-sensitive;
  treat single-run millisecond figures as one sample, not a mean.
  `results/results.json.generatedAt` timestamps exactly when.
  **Reproduce it yourself** — that's what `npm run measure` is for.
- **Headed vs headless is per-row and matters.** WebGPU rows ran in headed
  Chromium; WASM rows ran headless. We independently confirmed
  `navigator.gpu` is unavailable in headless Chromium entirely on this
  machine — first-party evidence for why headed-for-WebGPU isn't optional
  here. Every row in `results.json` records its own `browserMode`.
- **Cold-load time is not isolated inference latency.** It bundles network
  download, WASM/WebGPU session creation, and first inference. See finding
  #2 — do not read this study's numbers as a repeat of the cited prior art's
  isolated-latency figures.
- **The self-test page (`site/index.html`) is strictly less accurate than
  the harness**, by design of the public web platform: it uses Resource
  Timing, which cannot see true cross-origin transfer size without
  `Timing-Allow-Origin` (finding #7). It discloses this inline rather than
  hiding it; `results/results.json` (CDP-based) is authoritative.
- **One failure, recorded, not hidden or retried indefinitely.**
  distilgpt2/wasm failed on both allowed attempts and is in `results.json`
  as `status:"failed"` with the full engine error — that failure IS
  shippability data (finding #3), not an excluded row.
- **The advertised-bytes baseline is each model's own fp32 file on
  HuggingFace**, fetched via their tree API on 2026-08-15 — a real, citable
  number, but a naive one nobody actually ships. It is not a claim about
  what any specific blog post or tutorial says.

## Repo layout

```
scripts/lib/          pure logic — byte accounting, provider-fallback decision,
                       results assembly, resource-timing parsing, model corpus.
                       Everything here is unit tested (scripts/test/, vitest).
scripts/measure.mjs    the orchestrator: Playwright + CDP, drives pages/harness.html
scripts/local-server.mjs  zero-dependency static server (dynamic import + WASM
                          loading need http://, not file://)
pages/harness.html     deterministic, query-string-configured page the harness drives
pages/lib/instrument.js the actual in-browser instrumentation (GPU submit counter,
                        console capture, adapter-info readback, heap sampler) —
                        shared by pages/harness.html AND site/index.html so the
                        two measurement paths never drift apart
site/index.html        the visitor-facing standalone self-test (n=1, your machine)
results/results.json   committed, dated, full data + machine profile
results/RESULTS.md     generated table view of the same data
```

## Status

Measured, tested, committed. `npm test` — 67/67 green. `npm run measure` —
20/20 rows attempted, 19 ok, 1 recorded failure, 0 silently skipped. Not yet
published anywhere; this repo has local commits only.
