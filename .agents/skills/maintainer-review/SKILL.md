---
name: maintainer-review
description: Review a GitHub issue or pull request URL as an openai-agents-js maintainer, with a verdict on whether the claim is real, practically important, correctly scoped, and worth maintainer and contributor effort. Use when assessing issue validity or severity, deciding whether an issue should be prioritized or closed, judging whether a PR meets a real need and is worth bringing to mergeable quality, comparing open PRs that address the same issue, separating code quality from repository readiness, comparing a proposed fix with simpler alternatives, or drafting a concise maintainer assessment. When closure, additional evidence, or code changes should be requested, also produce a polite, concise, complete, copy-paste-ready maintainer comment in English.
---

# Maintainer Review

## Objective

Make a maintainer decision, not a generic diff summary. Separate these questions:

1. Is the claimed behavior real?
2. Can supported users plausibly reach it?
3. What happens when they do?
4. Is it important enough to act on now?
5. For a PR, is this solution worth merging and maintaining?
6. If competing PRs exist, which single implementation path should maintainers pursue?
7. What concise maintainer message should communicate closure, an evidence request, or required changes?

Lead with the verdict. Use the diff, issue narrative, and contributor effort as evidence, not as proxies for impact.

## Workflow

### 1. Establish the exact remote target

- Accept a GitHub issue or PR URL as the primary input. Resolve owner, repository, item type, and number before reviewing it.
- For an issue, read the full report, comments, reproduction, environment, linked material, and maintainer responses.
- For a PR, inspect the current remote base and head, full patch, commit history when relevant, tests, linked issue, and review discussion. Do not substitute the current local checkout for the remote change.
- State the claim in one falsifiable sentence. Separate the observed symptom from the proposed cause or fix.
- Identify the latest released boundary when compatibility or regression claims matter.

Use read-only GitHub access. On this laptop, do not run `gh` unless the user explicitly asks in the same turn. A review never authorizes comments, labels, branch changes, pushes, merges, or other remote writes.

### 2. Discover competing open PRs proportionally

Do this before deeply evaluating a specified PR. A PR URL selects the starting point, not necessarily the entire comparison set.

- Determine the primary issue from explicit closing keywords, linked issues, timeline/development links, PR body/comments, and the reproduced symptom. State when association is inferred.
- When an issue is explicitly linked, enumerate all open PRs that address it through cross-references, closing keywords, and development links. Include drafts but label them.
- When no issue is linked, run a bounded duplicate search using the strongest signals from the title, reproduction, violated invariant, and runtime path.
- Exclude closed/merged PRs from the active comparison set while using them as history when relevant.
- Require a shared issue, symptom, violated invariant, or materially overlapping path. A shared package label is not enough.
- If repository access cannot establish completeness, say so instead of claiming every candidate was found.

Compare candidates on need coverage, runtime correctness, placement, tests, compatibility, complexity, readiness, remaining maintainer work, and reusable pieces. Prefer the best maintainable solution, not the first or smallest diff by default.

### 3. Find the shortest decisive evidence path

Inspect the real runtime path before judging a change as trivial or meaningful. Check callers, public exports, equivalent streaming/non-streaming or provider/runtime paths, persistence, cleanup, and focused tests.

Start with `.agents/references/README.md` and open only the references for the affected boundary. Treat `.agents/references/` as read-only background during review. Verify every current claim against the remote change, current source, tests, docs, release boundary, and runtime evidence. Do not infer issue status or PR correctness from a reference. Recommend a separate reference-maintenance change when review reveals a durable invariant unless the user explicitly includes that update.

Use this evidence order:

1. Existing tests and a complete code-path trace.
2. A focused local reproduction of the exact claim.
3. A comparison with the latest release, base branch, or another known-good control.
4. A broader runtime matrix only when the decision remains uncertain.

Use a focused local reproduction by default when runtime behavior materially affects the verdict. Include a base/release control for regression claims. For latency, timeout, buffering, backpressure, or cleanup, measure an observable elapsed-time or state transition where feasible.

Use `$runtime-behavior-probe` only when the user explicitly invokes it or approves a proposed broader matrix. Preserve its environment-variable, live-service, cost, cleanup, and reporting gates. Ordinary maintainer review must not depend on that skill.

For validation, cleanup, retries, interruption, background work, or concurrency:

- Identify the earliest correct decision point after dynamic inputs are available.
- List resources acquired before and after it: listeners, promises/tasks, streams, connections, files, locks, caches, state mutations, and telemetry.
- Exercise failure during construction, connection, validation, execution, and cleanup where applicable.
- Verify explicit cleanup when failure occurs before normal teardown.
- Require a negative-path test when a listener, promise, stream, connection, process, or state can remain.

Stop when additional evidence is unlikely to change validity, severity, or maintainer action.

### 4. Calibrate validity and impact

Read [the evaluation framework](references/evaluation-framework.md) when validity, severity, or merge value is not immediately clear.

Assess claim validity, realistic reach, consequence, breadth, frequency, recoverability, compatibility, and severity. Keep observed facts separate from inference and name missing evidence that could change the result.

For a PR, make `Severity` describe the underlying issue or user need. Report patch-induced regression, compatibility, lifecycle, or maintenance risk separately as `Patch risk`.

Do not speculate about AI authorship or contributor intent. Identify weak reports through objective evidence: no reproduction, unsupported input, impossible path, duplicated handling, a test that does not exercise the claim, or a fix that is a runtime no-op.

### 5. Apply the maintainer-effort test

Use one code verdict:

- **Merge-worthy as-is**: real need, sound placement, proportionate scope, and adequate tests.
- **Merge-worthy after focused changes**: real need and viable direction with bounded corrections.
- **Supersede with a simpler alternative**: real need, but a smaller or more coherent fix is preferable.
- **Not worth completing**: negligible/unsupported impact, no-op behavior, wrong abstraction, or excessive completion cost.

For merge-worthy verdicts, use one repository-readiness status when useful:

- **Ready**
- **CI or review pending**
- **Rebase or conflict resolution required**
- **Blocked**

Omit readiness for supersede/not-worth-completing verdicts; CI does not change those code decisions. Do not downgrade sound code only because CI is pending, and do not call a PR ready when semantic changes remain.

For competing PRs, make one portfolio recommendation: choose one, choose one after focused changes, combine exact pieces into one destination, replace all with a simpler approach, or merge none. State what should happen to every active candidate.

Always consider at least one alternative: no code change, validation/error improvement, documentation, reuse of an existing helper, a narrower supported path, or enforcement at a different shared layer.

### 6. Report the decision and action

Choose the assessment language from the current user request and governing repository instructions. Maintainer comment drafts remain English.

Use the matching compact report in the evaluation framework. Keep the report decision-oriented, put unexpected/negative evidence first, and use no more than five evidence bullets by default.

When recommending closure, more evidence, focused changes, or superseding a PR, append a polite, complete, copy-paste-ready English maintainer comment. Include only merge-blocking work in its required-action paragraph. Do not produce a line-by-line review unless requested, equate passing tests with merge-worthiness, or equate a logically correct patch with practical value.

## Resource

- `references/evaluation-framework.md` contains the severity rubric, evidence checks, lifecycle review, issue dispositions, PR value checks, documentation threshold, competing-PR framework, maintainer-comment guidance, and compact report variants.
