# MLX prompt-cache experiment

Klide's MLX Harness now appends a TODO snapshot when its state changes instead
of rewriting an early system message. Unchanged state adds no tokens. The
latest snapshot carries the current list, including an empty list after a
clear. Other providers retain their existing refresh behavior; local Chat
continues to omit project TODOs.

The MLX-LM launcher also sets `--prompt-cache-bytes 1GB` (supported by the
installed mlx-lm 0.31.3). This is a budget for prompt reuse, not a cap on model
weights, total process memory, or the active context window. The server trims
retained caches while admitting batched work; a large active request can still
exceed the budget. MLX-VLM is not given this MLX-LM-specific flag. Restart MLX
from Klide after rebuilding the app to apply the launch setting. Older runtimes
must support this flag; no packages are upgraded automatically.

This targets reuse **between tool turns within a run**. Resuming a conversation
reconstructs context from its transcript, and the transient TODO snapshots are
not replayed. Compaction, model changes, tool-schema changes, and server cache
eviction can still prevent reuse. Historical snapshots also add a small amount
of context each time the list changes.

## Reproduce

Export synthetic requests from the real Rust Harness loop, using the real
OpenAI adapter's wire normalization:

```sh
cd src-tauri
KLIDE_MLX_CACHE_FIXTURE=/tmp/klide-mlx-cache.json cargo test --lib mlx_todo_updates_preserve_the_processed_prefix
```

With an MLX-LM server already running, from the workspace root:

```sh
python3 -B scripts/mlx-cache/bench.py \
  --fixture /tmp/klide-mlx-cache.json \
  --output /tmp/klide-mlx-cache-results.json \
  --repeats 1
```

`default_model` means the model configured when that server started, not a
particular model family. Only use `--model` for an already-loaded model: a
server may otherwise load/download a model in response to a request. The
script does not install anything or restart the server. **Use a server with a
prompt-cache byte budget.** Unique trials retain
separate caches, which can consume several GB on an unbounded server. It accepts only
loopback HTTP endpoints, ignores proxy configuration, and refuses redirects.

## What is measured

The fixture reads a synthetic 160-line Rust file, then completes TODO T1.
`rewrite` reconstructs the previous policy from the captured request;
`append` uses the current request verbatim. During development, the
reconstruction was checked against requests captured before the code change.

Each policy gets a warm request followed by the measured next request. A fresh
nonce at the start of each sample's system prompt isolates it from other
samples. Ordering alternates between policies. Initial model warmup is excluded.
Both policies use identical tools and sampling settings (temperature zero,
thinking disabled for the experiment, eight output tokens). Klide's production
sampling settings are unchanged. One repeat makes seven requests; three repeats
make 15, including warmup and two status checks. No returned tool call is executed.

The JSON records time to first nonempty streamed delta, total request time,
prompt tokens, server-reported cached tokens, and generated text. Missing
metrics stay null. Two simple status checks ask whether T1 is complete. These
are smoke tests, **not** evidence of coding accuracy or overall task speed.
Peak memory and int8/MTP performance are not measured by this experiment.
An interrupted report is partial (`complete: false`), not a successful benchmark.

Avoid other inference workloads while benchmarking. The server's cache is used
but never cleared; sample nonces prevent reuse between trials without deleting
another conversation's cache. Normal cache eviction still applies.

## Initial experiment — 2026-08-26

Apple M5, 16 GB RAM; existing MLX-LM server's `default_model` alias. Installed
versions: MLX 0.31.2, MLX-LM 0.31.3, MLX-VLM 0.6.3. The server startup log names
Qwen/Qwen3-4B-MLX-4bit; the API itself returns only the requested alias.

| Paired trial | Rewrite: first delta | Append: first delta | Rewrite cached tokens | Append cached tokens |
| --- | ---: | ---: | ---: | ---: |
| 1 | 3,759 ms | 550 ms | 2,649 | 5,634 |
| 2 | 5,612 ms | 568 ms | 2,649 | 5,634 |

Requests contained roughly 5,700 tokens, including tools and the fixture file.
The appended snapshot added about 19 prompt tokens while retaining the file's
processed prefix. The generated answer prefixes were consistent with task
completion, but the eight-token samples are not complete answers.

**The run was stopped during trial 3.** Server logs showed ten retained cache
entries totaling 7.54 GB; later requests slowed sharply. Memory pressure is a
likely explanation, not a measured OS-level diagnosis. The status smoke tests
did not run. These early samples demonstrate improved cache reuse, not a
validated general speedup or unchanged coding accuracy. They motivated the
launcher budget above; live results with that budget still need a server restart
and a new comparison. The current server was neither restarted nor cleared.
Raw partial results are in [2026-08-26-initial.json](results/2026-08-26-initial.json).
