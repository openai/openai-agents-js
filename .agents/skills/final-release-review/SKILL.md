---
name: final-release-review
description: Perform a release-readiness review by locating the previous release tag from remote tags and auditing the diff (for example, v1.2.3...TARGET) for breaking changes, regressions, improvement opportunities, and risks before releasing openai-agents-js.
---

# Final Release Review

## Purpose

Use this skill when validating the latest release candidate commit (default tip of `origin/main`) for release. It guides you to fetch remote tags, pick the previous release tag, and thoroughly inspect the `BASE_TAG...TARGET` diff for breaking changes, introduced bugs/regressions, improvement opportunities, and release risks.

The review must be stable and actionable: avoid variance between runs by using explicit gate rules, and never produce a `BLOCKED` call without concrete evidence and clear unblock actions.

## Quick start

1. Ensure repository root: `pwd` → `path-to-workspace/openai-agents-js`.
2. Sync tags and pick base (default `v*`):
   ```bash
   BASE_TAG="$(.agents/skills/final-release-review/scripts/find_latest_release_tag.sh origin 'v*')"
   ```
3. Choose target commit (default tip of `origin/main`, ensure fresh): `git fetch origin main --prune` then `TARGET="$(git rev-parse origin/main)"`.
4. Snapshot scope:
   ```bash
   git diff --stat "${BASE_TAG}"..."${TARGET}"
   git diff --dirstat=files,0 "${BASE_TAG}"..."${TARGET}"
   git log --oneline --reverse "${BASE_TAG}".."${TARGET}"
   git diff --name-status "${BASE_TAG}"..."${TARGET}"
   ```
5. Use the broad signals in `references/review-checklist.md` to find breaking-change, regression, and release-polish candidates.
6. Prove or dismiss each candidate with a BASE-versus-TARGET contract comparison and the owning SDK invariant from `.agents/references/README.md`.
7. Report only actionable findings and call the release gate: ship/block with concrete conditions.

## Deterministic gate policy

- Default to **🟢 GREEN LIGHT TO SHIP** unless at least one blocking trigger below is satisfied.
- Use **🔴 BLOCKED** only when you can cite concrete release-blocking evidence and provide actionable unblock steps.
- Blocking triggers (at least one required for `BLOCKED`):
  - A confirmed regression or bug introduced in `BASE...TARGET` (for example, failing targeted test, incompatible behavior in diff, or removed behavior without fallback).
  - A confirmed breaking public API/protocol/config change with missing or mismatched versioning and no migration path (for example, patch release for a breaking change).
  - A concrete data-loss, corruption, or security-impacting change with unresolved mitigation.
  - A release-critical packaging/build/runtime path is broken by the diff (not speculative).
- Non-blocking by itself:
  - Large diff size, broad refactor, or many touched files.
  - "Could regress" risk statements without concrete evidence.
  - Not running tests locally.
- If evidence is incomplete, do not block. Report a validation action only when the diff establishes a concrete unresolved risk; otherwise omit the candidate.

## Workflow

- **Prepare**
  - Run the quick-start tag command to ensure you use the latest remote tag. If the tag pattern differs, override the pattern argument (e.g., `'*.*.*'`).
  - If the user specifies a base tag, prefer it but still fetch remote tags first.
  - Keep the working tree clean to avoid diff noise.
- **Assumptions**
  - Assume the target commit (default `origin/main` tip) has already passed `$code-change-verification` in CI unless the user says otherwise.
  - Treat repository unit tests, lint, formatting, type checking, coverage, and changeset validation as CI evidence, not as the release audit. Do not rerun them by default.
  - Do not block a release solely because you did not rerun CI checks locally; focus on concrete behavioral, compatibility, packaging, or API risks.
  - Release policy: routine releases use patch versions; use minor only for breaking changes or major feature additions. Major versions are reserved until the 1.0 release.
- **Map the diff**
  - Use `--stat`, `--dirstat`, and `--name-status` outputs to spot hot directories and file types.
  - For suspicious files, prefer `git diff --word-diff BASE...TARGET -- <path>`.
  - Note any deleted or newly added tests, config, migrations, or scripts.
- **Discover candidates**
  - Walk through all categories in `references/review-checklist.md` (breaking changes, regression clues, improvement opportunities). Keep this broad scan so refactors, error handling, concurrency, dependencies, docs drift, and missing coverage remain visible.
  - Read changed tests to understand the intended behavior, exercised branches, and missing invariants. A changed or missing test is a clue, not a finding by itself.
- **Audit contract deltas**
  - Compare BASE and TARGET rather than reviewing TARGET in isolation.
  - For public APIs, compare exports, import identity, TypeScript signatures, parameter order, defaults, enums, and documented behavior.
  - For package metadata, compare supported Node.js and TypeScript versions, dependencies, peer and optional dependencies, package exports, published files, and ESM/CJS/type import behavior from packed artifacts.
  - For persisted state, schemas, protocols, config, and environment variables, identify the released durable boundary and verify backward-read or migration behavior where required.
  - Route each changed runtime area through the owning reference in `.agents/references/README.md`. Trace the affected value, state, item, identity, or side effect across all required downstream surfaces instead of stopping at the edited function.
  - Check only the relevant symmetry and failure axes: streaming/non-streaming, fresh/resumed, client/server-managed state, success/error/abort, sequential/concurrent, Node/browser/workerd, and normal/partial-failure/repeated cleanup.
- **Prove findings**
  - Promote a candidate to a finding only when the diff shows a concrete contract violation, a reachable supported-path regression, or a release-polish gap with user impact.
  - If static evidence cannot resolve a concrete semantic question, use the smallest public-path or packed-artifact probe that can. Prefer the same scenario against BASE and TARGET so environment failures and pre-existing behavior are separated from regressions.
  - Do not run repository unit-test slices merely to accumulate passing evidence. Run a focused test only when reproducing a specific failure or when no more direct contract, artifact, or runtime probe is available.
  - When you confirm a risk, cite the specific file/commit and explain the behavioral impact.
  - For every finding, include all of: `Evidence`, `Impact`, and `Action`.
  - Severity calibration:
    - **🟢 LOW**: low blast radius or clearly covered behavior; no release gate impact.
    - **🟡 MODERATE**: plausible user-facing regression signal; needs validation but not a confirmed blocker.
    - **🔴 HIGH**: confirmed or strongly evidenced release-blocking issue.
  - Attach a validation action only to a concrete unresolved risk. Give the smallest command or task and a pass condition; do not add generic follow-up checks.
  - Breaking changes do not automatically require a BLOCKED release call when they are already covered by an appropriate version bump and migration/upgrade notes; only block when the bump is missing/mismatched (e.g., patch bump) or when the breaking change introduces unresolved risk.
- **Form a recommendation**
  - State BASE_TAG and TARGET explicitly.
  - Provide a concise diff summary (key directories/files and counts).
  - List only substantiated breaking changes, regressions/bugs, improvement opportunities, and missing release notes/migrations. Do not turn every audit clue into a report item.
  - Recommend ship/block and the exact checks needed to unblock if blocking. If a breaking change is properly versioned (minor/major), you may still recommend a GREEN LIGHT TO SHIP while calling out the change. Use emoji and boldface in the release call to make the gate obvious.
  - If you cannot provide a concrete unblock checklist item, do not use `BLOCKED`.
  - Do not include routine command results, pass counts, skips, deselections, or a validation-status inventory. Mention a validation limitation only when it materially changes a specific finding or the release call.

## Output format (required)

All output must be in English.

Use the following report structure in every response produced by this skill. Be proactive and decisive: make a clear ship/block call near the top, and assign an explicit risk level (LOW/MODERATE/HIGH) to each finding with a short impact statement. Avoid overly cautious hedging when the risk is low and tests passed. Always use the fixed repository URL in the Diff section (`https://github.com/openai/openai-agents-js/compare/...`). Do not use `${GITHUB_REPOSITORY}` or any other template variable. Format risk levels as bold emoji labels: **🟢 LOW**, **🟡 MODERATE**, **🔴 HIGH**. Do not use Markdown links in the report. Keep the Diff URL as plain text, and cite repository files as plain text paths with optional line numbers.

Every risk finding must contain an actionable next step. If the report uses `**🔴 BLOCKED**`, include an `Unblock checklist` section with at least one concrete command/task and a pass condition.

```
### Release readiness review (<tag> -> TARGET <ref>)

This is a release readiness report done by `$final-release-review` skill.

### Diff

https://github.com/openai/openai-agents-js/compare/<tag>...<target-commit>

### Release call:
- **<🟢 GREEN LIGHT TO SHIP | 🔴 BLOCKED>** <one-line rationale>

### Scope summary:
- <N files changed (+A/-D); key areas touched: ...>

### Risk assessment (ordered by impact):
1) **<Finding title>**
   - Risk: **<🟢 LOW | 🟡 MODERATE | 🔴 HIGH>**. <Impact statement in one sentence.>
   - Evidence: <specific diff/test/commit signal; avoid generic statements>
   - Files: <path(s)>
   - Action: <concrete next step command/task with pass criteria>
2) ...

### Unblock checklist (required when Release call is BLOCKED):
1. [ ] <concrete check/fix>
   - Exit criteria: <what must be true to unblock>
2. ...

### Notes:
- <BASE/TARGET or other assumptions that materially affect the release call>
```

If no risks are found, include a "No material risks identified" line under Risk assessment and still provide a ship call. Do not add a verification-status section or report routine check results. If the report is not blocked, omit the `Unblock checklist` section.

## Resources

- `scripts/find_latest_release_tag.sh`: Fetches remote tags and returns the newest tag matching a pattern (default `v*`).
- `references/review-checklist.md`: Detailed signals and commands for spotting breaking changes, regressions, and release polish gaps.
