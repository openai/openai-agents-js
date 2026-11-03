# Compare settled answers and actual tool effects

This source-checkout example runs synthetic native Agent trials and writes a JSON result. Start with scripted responses to check the evaluation runner without an API key. Choose live mode explicitly when you want to compare model configurations.

From a built checkout with the native addon available, run:

```sh
pnpm exec tsx packages/agents/examples/evaluation/run.ts --mode scripted --repeats 2 --output /tmp/evaluation-harness.json
pnpm exec tsx packages/agents/examples/evaluation/run.ts --mode scripted --repeats 2 --baseline /tmp/evaluation-harness.json --output /tmp/evaluation-comparison.json
```

The second command compares against the first artifact. Run from the source checkout. The runner reads Git metadata and its TypeScript source to identify the experiment. The package manifest includes the TypeScript files and README, but excludes the default `cases.json` and `config.json` inputs.

## Inputs and modes

The synthetic catalog maps `A` to `violet` and `B` to `amber`. The `known` case asks for `A` and expects `violet`; the `absent` case asks for `Z` and expects `UNKNOWN`. Each case expects exactly one lookup of its code. Two repeats run each case twice.

Scripted mode is the default. It uses local mock responses, a real native Session, and the actual lookup callback. It needs no `OPENAI_API_KEY` and makes no live model request. It proves that the runner can record a tool round trip and score its result. It does not measure model quality.

Use `--mode live` only for live model trials. It requires a nonempty `OPENAI_API_KEY`. Missing credentials or live failure never switches to scripted responses. Run live trials only when you intend to use the configured provider.

To compare live configurations, choose a model available to your account in a copy of `config.json`, then run:

```sh
pnpm exec tsx packages/agents/examples/evaluation/run.ts --mode live --config /private/task/baseline-config.json --repeats 3 --output /private/task/baseline.json
pnpm exec tsx packages/agents/examples/evaluation/run.ts --mode live --config /private/task/candidate-config.json --repeats 3 --baseline /private/task/baseline.json --output /private/task/candidate.json
```

Create both configuration files first. Change only the instructions or model setting you want to compare. Both runs use the default cases. This runner creates a `NativeProvider` with the captured API key and the default endpoint. It does not forward `OPENAI_BASE_URL`. To select another provider, change the application explicitly. Three repeats per case give six trials, not a reliability estimate.

Optional `--cases <path>` and `--config <path>` select JSON inputs. Cases contain unique `id`, `prompt`, `expectedAnswer`, and ordered `expectedLookups` fields. Config contains `model`, `instructions`, optional `reasoningEffort`, and `timeoutMs`. Keep prompts and cases synthetic. Put credentials in the environment, not these files.

## Read the scores

Each trial reports three separate scores:

- `completed`: the answer settled without execution, tool, receipt, or cleanup errors.
- `answerExact`: completion succeeded and actual/expected answers match after trimming surrounding whitespace. Internal whitespace and case still matter.
- `toolBehavior`: completion succeeded and actual lookup effects match the expected `{code, output}` sequence exactly. Missing, duplicate, extra, reordered, or wrong-output lookups fail.

A trial passes only when all three scores pass. Expected-looking text cannot hide an extra tool effect. The runner records effects from callback execution and checks scripted tool-output receipts; it does not infer calls from the answer.

For a comparison, hold mode, cases, catalog, repeats, and scorer identity fixed. The runner validates baseline compatibility before trials. Config may differ because the comparison tests changes to instructions or model settings.

Results record the source revision, dirty-checkout flag, example content digest, and case/catalog/config hashes. The revision alone does not identify uncommitted example code. Comparisons also retain the baseline's source identity and config hash. Scripted and live results cannot share a baseline.

A comparison reports score regressions and the change in passing trials. Small synthetic samples do not establish reliability or performance on unseen tasks.

## Failures, waiting, and cleanup

The JSON retains failed and timed-out trials, including effects already observed. Failed trials make the CLI exit nonzero after writing the result. Invalid inputs or incompatible baselines reject before trials. Error records contain one of these fixed `kind` values: `timeout`, `native`, `tool`, `receipt`, `cleanup`, or `execution`. They omit raw exception messages, stacks, credentials, and headers. Synthetic answers and effects remain part of the artifact.

`timeoutMs` defaults to 60000 ms and bounds the result wait after `submit()` returns. It does not bound Session opening, submit admission, or cleanup. The runner awaits Session cleanup before releasing the provider or scripted peer.

A cleanup failure stops later trials, sets `aborted: true`, retains executed trials, and omits the comparison, even if it occurs on the last trial. Cleanup failures cannot earn a passing score. Cleanup may take longer than the wait, so this is not a hard wall-clock, token, or billing ceiling.
