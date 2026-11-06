# Compare settled answers and actual tool effects

Run two catalog lookups and score both the answer and the tool calls that produced it. Start with scripted responses to check the runner. Use live mode to compare model configurations.

Run the commands from the repository root with [matching built packages and native runtime](../guides/building.md). The runner reads Git metadata, TypeScript source, and the default [cases](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/evaluation/cases.json) and [configuration](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/examples/codex/evaluation/config.json) from the checkout. The npm package includes the example source and README. Its default JSON inputs live in the repository.

Create a private output directory in a POSIX shell. Keep the shell open while you compare runs.

```sh
EVAL_DIRECTORY=$(mktemp -d)
pnpm exec tsx examples/codex/evaluation/run.ts --mode scripted --repeats 2 --output "$EVAL_DIRECTORY/scripted.json"
pnpm exec tsx examples/codex/evaluation/run.ts --mode scripted --repeats 2 --baseline "$EVAL_DIRECTORY/scripted.json" --output "$EVAL_DIRECTORY/comparison.json"
```

The first run writes a baseline. The second reports any score regressions and the change in passing trials.

## Inputs and modes

The catalog maps `A` to `violet` and `B` to `amber`. The `known` case asks for `A` and expects `violet`. The `absent` case asks for `Z` and expects `UNKNOWN`. Each case expects exactly one lookup. Two repeats run each case twice.

Scripted mode uses local responses, a real native Session, and the lookup callback. It checks the tool round trip and scorer without a model API key.

### Compare live configurations

Set `OPENAI_API_KEY` in the environment and choose a model available to that account. The runner creates a `NativeProvider` with the key and its default endpoint. To use another endpoint, configure the provider in the application. Live failures stay visible as failures.

Create the two configurations in the private directory from the first step.

```sh
cp examples/codex/evaluation/config.json "$EVAL_DIRECTORY/baseline-config.json"
cp "$EVAL_DIRECTORY/baseline-config.json" "$EVAL_DIRECTORY/candidate-config.json"
```

Choose the baseline model in both files, then change the instructions or model in the candidate. Run each configuration against the same cases. Three repeats produce six live trials per configuration.

```sh
pnpm exec tsx examples/codex/evaluation/run.ts --mode live --config "$EVAL_DIRECTORY/baseline-config.json" --repeats 3 --output "$EVAL_DIRECTORY/baseline.json"
pnpm exec tsx examples/codex/evaluation/run.ts --mode live --config "$EVAL_DIRECTORY/candidate-config.json" --repeats 3 --baseline "$EVAL_DIRECTORY/baseline.json" --output "$EVAL_DIRECTORY/candidate.json"
```

Use `--cases` and `--config` to select other JSON files. Each case has a unique `id`, a `prompt`, an `expectedAnswer`, and ordered `expectedLookups`. The configuration has `model`, `instructions`, optional `reasoningEffort`, and `timeoutMs`. Keep credentials in the environment and use synthetic prompts and cases.

## Read the scores

Each trial reports three scores.

- **`completed`** checks that the answer settled without execution, tool, receipt, or cleanup errors.
- **`answerExact`** requires successful completion and matching actual and expected answers after trimming surrounding whitespace. Internal whitespace and case still matter.
- **`toolBehavior`** requires successful completion and actual lookup effects that match the expected `{code, output}` sequence exactly. Missing, duplicate, extra, reordered, or wrong-output lookups fail.

A trial passes only when all three scores pass. Expected-looking text cannot hide an extra tool effect. The runner records effects when the callback executes and checks the scripted tool-output receipts.

For a comparison, hold mode, cases, catalog, repeats, and scorer identity fixed. The runner validates baseline compatibility before trials. Config may differ because the comparison tests changes to instructions or model settings.

Results record the source revision, dirty-checkout flag, example content digest, and case/catalog/config hashes. The revision alone does not identify uncommitted example code. Comparisons also retain the baseline's source identity and config hash. Scripted and live results cannot share a baseline.

A comparison reports score regressions and the change in passing trials. Small synthetic samples do not establish reliability or performance on unseen tasks.

## Failures, waiting, and cleanup

The JSON retains failed and timed-out trials, including effects already observed. Failed trials make the CLI exit nonzero after writing the result. Invalid inputs or incompatible baselines reject before trials. Error records contain one of these fixed `kind` values: `timeout`, `native`, `tool`, `receipt`, `cleanup`, or `execution`. They omit raw exception messages, stacks, credentials, and headers. Synthetic answers and effects remain part of the artifact.

`timeoutMs` defaults to 60000 ms and bounds the result wait after `submit()` returns. It does not bound Session opening, submit admission, or cleanup. The runner awaits Session cleanup before releasing the provider or scripted peer.

A cleanup failure stops later trials, sets `aborted: true`, retains executed trials, and omits the comparison, even if it occurs on the last trial. Cleanup failures cannot earn a passing score. Cleanup may take longer than the wait, so this is not a hard wall-clock, token, or billing ceiling.

## Compare two fixed catalog cases

The smaller [catalog evaluation](../evaluate-catalog.ts) runs each of two scripted cases once. Use Node.js 24 and a private directory. Run these commands from the checkout root.

```sh
CATALOG_DIRECTORY=$(mktemp -d)
pnpm exec tsx examples/codex/evaluate-catalog.ts "$CATALOG_DIRECTORY/candidate.json"
pnpm exec tsx examples/codex/evaluate-catalog.ts "$CATALOG_DIRECTORY/next.json" "$CATALOG_DIRECTORY/candidate.json"
```

The first command writes an artifact. The second compares a new artifact with that baseline. The scorer checks completion, the trimmed exact answer, and the ordered tool arguments separately. A duplicate lookup fails the tool check even when the answer matches.

The artifact records synthetic answers and calls, case and catalog fingerprints, model, instructions, and failure categories. It omits raw errors, headers, and keys. A failed trial still writes an artifact and returns a failing exit status.

A baseline must match the artifact format, scripted mode, case and catalog fingerprint, scorer, and both unique case IDs. Model and instruction changes remain visible. Compare case regressions and the change in passed count. These two cases test the integration. Use a separate experiment to assess live model quality or speed.
