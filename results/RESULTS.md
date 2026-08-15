# shipgauge — measured results

Generated: 2026-08-15T05:26:07.273Z

**n = 20 rows** (model x device configurations measured on ONE machine — see README for what n means here).

## Machine profile

- GPU: amd / rdna-4 / 0x7590 — "AMD Radeon RX 9060 XT"
- RAM: 31.1 GB
- OS: win32 10.0.26200
- Browser: Chromium 151.0.7922.34

## Rows

| model | task | device | mode | provider (readback) | cold bytes | vs advertised | cold->infer | cache honored | peak heap |
|---|---|---|---|---|---|---|---|---|---|
| minilm-l6 | feature-extraction | wasm | headless | wasm | 26.81 MB | -68.9% | 6220ms | yes | 7.06 MB |
| minilm-l6 | feature-extraction | webgpu | headed | webgpu | 26.81 MB | -68.9% | 6648ms | yes | 7.25 MB |
| minilm-l12 | feature-extraction | wasm | headless | wasm | 37.34 MB | -70.6% | 8434ms | yes | 7.08 MB |
| minilm-l12 | feature-extraction | webgpu | headed | webgpu | 37.34 MB | -70.6% | 9138ms | yes | 7.99 MB |
| bge-small | feature-extraction | wasm | headless | wasm | 37.34 MB | -70.6% | 8266ms | yes | 6.86 MB |
| bge-small | feature-extraction | webgpu | headed | webgpu | 37.34 MB | -70.6% | 9294ms | yes | 7.75 MB |
| gte-small | feature-extraction | wasm | headless | wasm | 37.34 MB | -70.6% | 9248ms | yes | 7.08 MB |
| gte-small | feature-extraction | webgpu | headed | webgpu | 37.34 MB | -70.6% | 9836ms | yes | 7.98 MB |
| distilbert-sst2 | sentiment-analysis | wasm | headless | wasm | 69.37 MB | -72.9% | 14522ms | yes | 6.38 MB |
| distilbert-sst2 | sentiment-analysis | webgpu | headed | webgpu | 69.37 MB | -72.9% | 15266ms | yes | 7.28 MB |
| albert-base-v2 | feature-extraction | wasm | headless | wasm | 16.45 MB | -61.9% | 4935ms | yes | 18.52 MB |
| albert-base-v2 | feature-extraction | webgpu | headed | webgpu | 16.45 MB | -61.9% | 4988ms | yes | 17.16 MB |
| bert-base-ner | token-classification | wasm | headless | wasm | 108.84 MB | -73.5% | 21466ms | yes | 6.77 MB |
| bert-base-ner | token-classification | webgpu | headed | webgpu | 108.84 MB | -73.5% | 23868ms | yes | 7.30 MB |
| paraphrase-multilingual-minilm-l12 | feature-extraction | wasm | headless | wasm | 133.89 MB | -70.1% | 31789ms | yes | 89.70 MB |
| paraphrase-multilingual-minilm-l12 | feature-extraction | webgpu | headed | webgpu | 133.89 MB | -70.1% | 28907ms | yes | 87.18 MB |
| lamini-flan-t5-77m | text2text-generation | wasm | headless | wasm | 96.02 MB | -56.7% | 19596ms | yes | 18.49 MB |
| lamini-flan-t5-77m | text2text-generation | webgpu | headed | webgpu | 96.02 MB | -56.7% | 21039ms | yes | 18.75 MB |
| distilgpt2 | text-generation | wasm | headless | *failed: Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: /mnt/vss/_work/1/s/onnxruntime/core/graph/graph_utils.cc:30 int onnxruntime::graph_utils::GetIndexFromNam…* | — | — | — | — | — |
| distilgpt2 | text-generation | webgpu | headed | webgpu | 161.78 MB | -48.3% | 32552ms | yes | 16.97 MB |

## Method notes

- n = number of (model, device) rows measured on ONE machine, ONE run. This is a method demonstration, not a population claim — see README "Limits" before generalizing any number here.
- coldTotalTransferBytes is the sum of CDP Network.loadingFinished encodedDataLength across every non-cached request during first load in a fresh incognito context (transformers.js runtime + WASM binary + tokenizer/config files + model weights). It is the same figure Chrome DevTools' Network panel calls "Transferred", not the decoded/decompressed size.
- warmTotalTransferBytes measures a second load in the SAME browser context (same disk/memory cache) — this is what "does it re-download on revisit" actually tests.
- webgpu rows ran in headed Chromium (--enable-unsafe-webgpu); wasm rows ran headless. Every row records its own browserMode.
- provider.actualProvider is derived from a real runtime signal (GPUQueue.submit() call count, captured by monkey-patching the WebGPU API before transformers.js loads), never from the device string we requested — see scripts/lib/provider-readback.mjs.
- peakJsHeapBytes is read via CDP Performance.getMetrics (JSHeapUsedSize), not the privacy-quantized performance.memory API.
- Observed on this machine: navigator.gpu is not available in headless Chromium at all (gpuAdapterAvailable=false on every wasm/headless row), even though the same binary exposes a working WebGPU adapter when headed. This is exactly why webgpu rows are never run headless in this harness — it is also independent, first-party confirmation of the "WebGPU in headless is unreliable" premise this study started from.
- GPUAdapterInfo.device and .description are redacted to empty strings by Chromium unless launched with --enable-webgpu-developer-features (vendor/architecture are exposed either way) — the machineProfile above was captured with that flag.
