# Release Diff Review Checklist

## Quick commands

- Sync tags: `git fetch origin --tags --prune`.
- Identify latest release tag (default pattern `v*`): `git tag -l 'v*' --sort=-v:refname | head -n1` or use `scripts/find_latest_release_tag.sh`.
- Generate overview: `git diff --stat BASE...TARGET`, `git diff --dirstat=files,0 BASE...TARGET`, `git log --oneline --reverse BASE..TARGET`.
- Inspect risky files quickly: `git diff --name-status BASE...TARGET`, `git diff --word-diff BASE...TARGET -- <path>`.

## Gate decision matrix

- Choose `🟢 GREEN LIGHT TO SHIP` when no concrete blocking trigger is found.
- Choose `🔴 BLOCKED` only when at least one blocking trigger has concrete evidence and a defined unblock action.
- Blocking triggers:
  - Confirmed regression/bug introduced in the diff.
  - Confirmed breaking public API/protocol/config change with missing or mismatched versioning/migration path.
  - Concrete data-loss/corruption/security-impacting issue with unresolved mitigation.
  - Release-critical build/package/runtime break introduced by the diff.
- Non-blocking by itself:
  - Large refactor or high file count.
  - Speculative risk without evidence.
  - Not running tests locally.
- If uncertain, keep the gate green. Add a focused follow-up only when it resolves a concrete risk already identified in the diff.

## Actionability contract

- Every risk finding should include:
  - `Evidence`: specific file/commit/diff/test signal.
  - `Impact`: one-sentence user or runtime effect.
  - `Action`: concrete command/task with pass criteria.
- A candidate becomes a finding only when it has a concrete contract violation, a reachable supported path, or a release-polish gap with user impact.
- Changed tests, missing tests, diff size, and risky patterns are discovery signals; they are not findings without contract or runtime evidence.
- A `BLOCKED` report must contain an `Unblock checklist` with at least one executable item.
- If no executable unblock item exists, do not block. Keep the gate green and include an action only for a concrete unresolved risk.

## Two-stage audit

### Stage 1: broad discovery

Use all of the existing breaking-change, regression, dependency, documentation, and improvement signals below. The goal is high recall: collect plausible candidates without prematurely reporting them.

Read changed tests as behavioral documentation. Identify the intended outcome, covered branches, deleted assertions, new skips, and missing failure paths, but do not rerun repository unit tests merely to accumulate passing evidence.

### Stage 2: contract and invariant proof

For each candidate:

1. Compare the released BASE behavior or contract with TARGET. Do not infer compatibility from TARGET alone.
2. Identify the owning SDK boundary using `.agents/references/README.md`.
3. Trace the changed value, state, item, identity, or side effect across every downstream consumer required by that boundary.
4. Check the relevant paired paths and failure modes.
5. Promote the candidate to a finding only when this trace establishes concrete impact.

Use these contract comparisons when relevant:

| Changed surface | BASE-versus-TARGET audit |
| --- | --- |
| Public API | Exports, import identity, TypeScript signatures, parameter order, defaults, enums, and documented behavior |
| Runner and run items | Provider output, result items, semantic stream events, session history, replay, handoffs, and `RunState` |
| Tool execution | Planning, approvals, guardrails, invocation, hooks, output conversion, persistence, aborts, and cleanup |
| Conversation and sessions | First turn, follow-up, retry, filtering, handoff, compaction, interruption, and resume |
| Model and provider adapters | Model/settings resolution, request conversion, streaming terminals, provider data, errors, retries, and transport ownership |
| Persisted schemas and config | Serialized shape, version support, backward reads, migrations, defaults, environment variables, and wire compatibility |
| Package boundary | Supported Node.js and TypeScript versions, dependencies, peers, optional dependencies, package exports, published contents, and ESM/CJS/type behavior from packed artifacts |

Select only the axes implicated by the diff:

- streaming versus non-streaming;
- fresh execution versus serialized resume;
- client-managed versus server-managed state;
- success, exception, and abort;
- sequential versus concurrent execution;
- Node.js versus browser versus workerd;
- normal, partial-failure, and repeated cleanup.

If static inspection cannot resolve a concrete semantic question, run the smallest public-path or packed-artifact probe that can. Prefer an identical BASE and TARGET scenario. A focused unit test is a fallback for reproducing a specific failure, not the default release validation.

## Breaking change signals

- Public API surface: removed/renamed exports, changed parameters/return types, default values changed, new required options, stricter validation.
- Protocol/schema: request/response fields added/removed/renamed, enum changes, JSON shape changes, ID formats, pagination defaults.
- Config/CLI/env: renamed flags, default behavior flips, removed fallbacks, environment variable changes, logging levels tightened.
- Dependencies/platform: major version bumps, Node/TypeScript target changes, polyfill removal, new peer dependencies.
- Persistence/data: migration scripts missing, data model changes, stored file formats, cache keys altered without invalidation.
- Docs/examples drift: examples still reflect old behavior or lack migration note.
- Semver alignment: breaking changes should be paired with the expected version bump and clear migration notes; treat mismatches as blockers, not the breaking change alone. Project policy: routine releases are patch; use minor for breaking changes or major feature additions; reserve major until 1.0.

## Regression risk clues

- Large refactors with light test deltas or deleted tests; new `skip`/`todo` markers.
- Concurrency/timing: new async flows, retries, timeouts, debounce/caching changes, race-prone patterns.
- Error handling: catch blocks removed, swallowed errors, broader catch-all added without logging, stricter throws without caller updates.
- Stateful components: mutable shared state, global singletons, lifecycle changes (init/teardown), resource cleanup removal.
- Third-party changes: swapped core libraries, feature flags toggled, observability removed or gated.

## Improvement opportunities

- Missing coverage for new code paths; add focused tests.
- Performance: obvious N+1 loops, repeated I/O without caching, excessive serialization.
- Developer ergonomics: unclear naming, missing inline docs for exported APIs, missing examples for new features.
- Release hygiene: add migration/upgrade note when behavior changes; ensure changelog/notes capture user-facing shifts.

## Evidence to capture in the review output

- BASE tag and TARGET ref used for the diff; confirm tags fetched.
- High-level diff stats and key directories touched.
- Only concrete, actionable findings with evidence, impact, affected files, and action.
- A validation command or task only when it resolves a specific finding; include its pass criteria.
- Explicit release gate call (ship/block) with conditions to unblock.
- `Unblock checklist` section when (and only when) gate is `BLOCKED`.
- Do not report routine command results, pass counts, skips, deselections, or a validation-status inventory.
