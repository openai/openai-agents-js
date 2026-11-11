# Classic and native Agents SDK benchmark

This benchmark compares completed public API work against a local synthetic Responses server. It measures SDK overhead, process startup and retained-session behavior. It does not measure model quality, real model service latency or application performance. No benchmark results are published here yet.

The fixture and worker preserve the established workloads and assertions. Each SDK worker is a fresh Node process. Within a retained workload, one session keeps the full prior user/assistant/tool history. Paired rounds alternate implementation order. One fixture persists across an invocation and resets histories between workers; its heap/JIT state persists. Keep that lifetime fixed when comparing runs. A fresh fixture per invocation is a different control.

## Requirements and inputs

Use Node 22 or newer, Python 3.11 or newer for analysis, and two separately installed/built SDKs. The classic adapter targets the public APIs shipped in `@openai/agents@0.21.0`; the native adapter targets the `NativeProvider`, `Agent.session` and turn-event APIs in this branch. Matching a version string does not qualify a different API generation. Build and test the native SDK normally before measuring; this script does not build or install it.

Declare both public entry paths and package versions. The controller checks each declaration against the nearest `@openai/agents/package.json`. It records entry/package hashes, Zod metadata, optional revision labels, Node/platform/architecture and harness hashes in each row. Both tool adapters must resolve the same Zod version. Retain exact dependency lockfiles, source revision/patch, native build receipt and binary hashes separately: hashing a re-exporting public entry alone does not identify its transitive or native implementation. Revision labels are caller declarations, not source verification.

Example setup, from the repository root, with a separately pinned baseline installation:

```sh
export V0_ENTRY="/absolute/released-install/node_modules/@openai/agents/dist/index.mjs"
export V0_VERSION="0.21.0"
export V1_ENTRY="$PWD/packages/agents/dist/index.mjs"
export V1_VERSION="$(node -p 'JSON.parse(require("node:fs").readFileSync("packages/agents/package.json", "utf8")).version')"
export V1_REVISION="your-reviewed-revision"
```

Run both sides on the same host, OS, Node release, affinity, allocator/thread defaults and effective certificate/proxy configuration. Do not mix debug/release native builds. Stop other work you control and record host load/pressure before and after; this cannot prove global host exclusivity. The controller removes both API-key variables from child environments and uses a fixture credential. No external model or trace exporter is required. Environment preload/instrumentation flags are rejected. Both `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE` must be unset for this fixed protocol because they can change cold-import behavior. Supported profiling options below produce diagnostic data only.

## Workloads and controls

| Case | Public work | Setup outside warm timing |
| --- | --- | --- |
| cold-import | Import public facade in a fresh process | None |
| cold-first | One useful one-shot answer | Import/construction are separately reported |
| warm-one-shot | Repeated `Agent.run` or classic `Runner.run` | One warmup; each native one-shot owns its internal session lifecycle |
| warm-session | Repeated turns in one retained session | Open and one warmup |
| stream-session | Same retained turns plus exact complete streamed text | Open and one warmup |
| tool1 | One tool call then final answer per turn | Open and one warmup |
| tool8 | Eight parallel tool calls in one model round then final | Open and one warmup |
| tool-chain8 | Eight serial one-tool model rounds then final | Open and one warmup |
| history100 | Retained turns after 100 prefill turns with 1024-byte input padding | Prefill, open and one warmup |
| concurrent8 | Eight independent retained sessions | Open/warmup each lane; shared measured barrier |

Configuration uses `BENCH_CASES` (comma-separated table names), `BENCH_SIDES` (`v0,v1` by default), `BENCH_ROUNDS` (default 5), `BENCH_TURNS` (default 20 per lane), `BENCH_OUTPUT_BYTES` (default 256 padding target), `BENCH_STREAM_CHUNKS` (default 8), `BENCH_MODEL_DELAY_MS` (default 0), `BENCH_TRACE` (`off`/`on`) and `BENCH_TIMEOUT_MS` (default 120000 per worker). Cold-first always performs one turn regardless of `BENCH_TURNS`. Input/output bytes and actual completed work are reported, not inferred from requested iteration counts.

Smoke/exploratory example; use new files and check every command's exit status:

```sh
BENCH_CASES=warm-session,stream-session,tool-chain8,history100 \
  BENCH_ROUNDS=5 BENCH_TURNS=20 \
  node scripts/benchmarks/agents-parity/run.mjs > exploratory.jsonl 2> exploratory.stderr
python3 scripts/benchmarks/agents-parity/analyze.py results exploratory.jsonl
```

The worker verifies final text and all streamed deltas, rejects stream gaps, and checks trace activity/off state. The server verifies exact retained text and tool IDs/names/arguments/results. The controller verifies zero fixture/SDK errors, exact request/tool counts and normal child/fixture exits. Errors/timeouts terminate collection; keep partial files and stderr, but do not treat them as a completed matrix. The controller supervises its direct children. Use an OS job/container supervisor when whole-tree cleanup is needed, especially for forced termination. These tools do not supply the surrounding provenance audit or an acceptance orchestrator.

## Measurement and statistical limits

Warm `measuredWallMs` and process CPU exclude import, construction, prefill/warmup, open/close and fixture-control requests. Turn latency includes the actual public turn call and completion; one-shot includes its internal lifecycle. Lifecycle/process-wall fields cover broader work, including trace flush. Cold-first reports first useful completion from parent process launch separately from after construction. These are fresh-process observations with uncontrolled filesystem-cache state, not disk-cold tests. RSS/peak RSS/context switches are process resource observations, not heap/leak evidence; check OS support before interpreting them.

The analyzer preserves all rounds and raw tails. It rejects errors, profiled/preloaded/marked diagnostic captures, mismatched parameters, missing pairs and unequal completed work. Metadata equality is checked within each workload/file when fields are supplied. Legacy rows may omit `inputs`, `runtime` and `sources`; if all relevant rows omit a field, the analyzer accepts its absence and does not verify that metadata. Mixing present and missing values in one workload is rejected. Use the portable controller's metadata-bearing rows plus the external input audit for a reviewable comparison; legacy compatibility does not establish provenance. The analyzer reports per-worker metric medians/ranges and a deterministic paired bootstrap interval for the ratio of medians. Worker processes, not individual turns, are the resampling units. The turn quantile uses `sorted[floor(q*n)]`, so named p95 is the maximum at 20 turns. Five paired rounds are exploratory and give weak tail/interval precision. More turns within one session change history depth; they do not create independent replicas.

Before running a comparison, record the cases, metrics, tolerances, and stop criteria.

- Collect at least 10 paired workers per warm case at 20 turns and again at 50 turns. Keep separate files and summaries for the two turn counts. Include the 16,384-byte, 512-chunk streaming case in both.
- Collect 30 fresh-process pairs per cold case.
- Keep the 100 ms model-delay and trace-on runs separate from the zero-delay baseline.

The analyzer's minimum-round setting checks the sample count. It always reports `acceptanceEstablished=false`. Review the full test matrix, build provenance, and host load before drawing conclusions.

Example primary warm collection (eight default warm cases); repeat with 50 turns in a different file:

```sh
BENCH_CASES=warm-one-shot,warm-session,stream-session,tool1,tool8,tool-chain8,history100,concurrent8 \
  BENCH_ROUNDS=10 BENCH_TURNS=20 \
  node scripts/benchmarks/agents-parity/run.mjs > warm20.jsonl 2> warm20.stderr
BENCH_CASES=stream-session BENCH_OUTPUT_BYTES=16384 BENCH_STREAM_CHUNKS=512 \
  BENCH_ROUNDS=10 BENCH_TURNS=20 \
  node scripts/benchmarks/agents-parity/run.mjs > large20.jsonl 2> large20.stderr
BENCH_CASES=cold-import,cold-first BENCH_ROUNDS=30 BENCH_TURNS=1 \
  node scripts/benchmarks/agents-parity/run.mjs > cold.jsonl 2> cold.stderr
python3 scripts/benchmarks/agents-parity/analyze.py results --min-rounds 10 warm20.jsonl large20.jsonl
python3 scripts/benchmarks/agents-parity/analyze.py results --min-rounds 30 cold.jsonl
```

## Tracing and profiling

Trace-off explicitly disables classic tracing and leaves native telemetry unconfigured. Trace-on uses local custom processors, requires nonzero records and checks available native flush/drop/failure counters. Classic/native span/event counts differ by design; they are not equal-work counters. This measures configured SDK tracing work without exporter/network delivery and cannot predict every production tracing backend.

`BENCH_CPU_PROFILE_DIR` enables the existing Inspector profile only around the measured region. It excludes import/setup/warmup and final fixture control/retained teardown. Native one-shot's internal close remains inside its call. V8 samples the Node thread, not Rust Tokio CPU; idle samples and process-CPU subtraction cannot identify native functions. `BENCH_WORKER_IMPORT` is a diagnostic worker preload hook. The analyzer rejects both options' rows as comparison evidence. Keep all profiles and derived artifacts separate from uninstrumented results.

Raw output can contain caller-supplied paths and revision labels. Retain original evidence privately; publish a sanitized copy that preserves versions/hashes, all observed values and outliers without local home paths or credentials. Do not trim slow rounds, pool horizons, change fixture lifetime silently or choose a different stop point after seeing a favorable median.
