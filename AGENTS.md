# Contributor Guide

## Policies & Mandatory Rules

### Security Requirements

Read and follow [CONTRIBUTING.md#security](CONTRIBUTING.md#security) for credentials, diagnostics, dependencies, sensitive-change review, CI isolation, and release integrity; use [SECURITY.md](SECURITY.md) for scope and private vulnerability reporting. Public PR/review instructions do not authorize disclosure of undisclosed vulnerabilities or sensitive evidence.

- Never print real credentials or customer data. Preserve redaction and tracing opt-outs; check affected success, error, streaming, retry, and resume paths.
- Do not invent dependency cooldowns or infer runtime exploitability from an alert’s presence or absence.
- Record reviewed revision, coverage limits, checks, and unresolved findings. Documentation or completed scans do not prove configured controls, resolved findings, or compliance. Keep unverified controls and unapproved exceptions unresolved; do not turn proposed response targets into promised deadlines.

### Mandatory Skill Usage

Read the applicable `.agents/skills/<name>/SKILL.md` and only its needed references. These triggers authorize skill use unless manual invocation is explicitly required. User instructions and approved scope override skill defaults, subject to permissions; do not repeat granted approvals.

| Skill | Trigger and requirements |
| --- | --- |
| `implementation-strategy` | Before changing/reviewing runtime, public APIs, configuration, persisted schemas, or wire protocols. Record behavior, compatibility, unsupported cases, and an existing alternative. Revisit changed contracts/designs; independent reviewers inherit the contract and report uncertainty rather than rerunning strategy. |
| `implementation-final-review` | After focused checks, before broad checks: runtime, tests, examples, build/test behavior, behavior-impacting docs. Entrypoint classifies lightweight/ordinary/high-risk; only demonstrably non-semantic changes may omit independent review. |
| `code-change-verification` | Final SDK stack for `packages/`, `examples/`, `helpers/`, `scripts/`, `integration-tests/`, or root build/test config (`package.json`, lock/workspace files, `tsconfig*`, `tsc-multi.json`, ESLint/Vitest config). Skill owns command order, installation/build barriers, sandbox/capacity checks, and retries. Lightweight review does not waive it. |
| `changeset-validation` | Any `packages/` or `.changeset/` change: create/validate changesets for every changed package, with Conventional Commit summaries. Final validation follows review, alongside SDK verification, before handoff. |
| `openai-knowledge` | External evidence for OpenAI API/platform behavior. Use local code for SDK-owned behavior; do not repeat unchanged external research for local details. |
| `pr-draft-summary` | After review, changeset validation, and verification: local draft for runtime, tests, examples, build/test changes, or behavior-impacting docs, including uncommitted work. |

- Planning/investigation/report-only work skips implementation review. Repo-meta uses applicable skill validation; changed decision-making guidance requires realistic scenarios and an independent pass.
- Docs-only/repo-meta skips the final SDK stack unless build/test behavior changes or the user requests it.
- Automatic drafts exclude repo-meta, non-behavioral docs, conversation-only work, and user opt-outs. Explicit draft requests override exclusions; drafts authorize no Git mutation.
- Continue authorized fixes, review, verification, and handoff. Stop only for unresolved scope/contracts, missing authority, or external blockers; cite the blocking skill instruction and missing decision. Never ask for generic continuation or mutate GitHub.

### Documentation Change Verification Tiers

Apply the highest tier across the complete task-owned diff: committed, staged, unstaged, and untracked. Skills must reference this policy, not duplicate it. These checks supplement all applicable skill gates.

| Tier | Changes | Required checks |
| --- | --- | --- |
| Editorial | Spelling/grammar/punctuation/formatting or wording with identical technical meaning; no claims, links, anchors, frontmatter, snippets/imports, navigation, Astro config, or generators changed | `git diff --check`; Prettier on changed Markdown/MDX. No docs build, snippet check, or independent behavior review unless another gate requires it. |
| Content | Technical claims, API names/defaults/behavior, links, anchors, frontmatter, snippet imports/rendering, or `examples/docs/` TS/TSX | Verify changed claims against implementation/authoritative sources; diff/Prettier checks on changed docs/snippets; `pnpm -F docs-code build-check` for changed rendered TS/TSX sources or wiring. No docs build without Structural changes. |
| Structural | Navigation, routes, layout, sidebar, Astro/docs-build config, documentation/translation generators | Content checks plus `pnpm docs:build`; `pnpm docs:scripts:check` for `docs/src/scripts/**`. |

Edit authored English only unless translation is requested; generated `docs/src/content/docs/{ja,ko,zh}` then becomes expected output. Follow [snippet/authoring rules](#repo-structure--important-files). Never translate as routine verification.

### Manual Documentation Translation

Use the repository translator, not independent localized rewrites. CI builds/checks docs but does not regenerate translations ([#1321](https://github.com/openai/openai-agents-js/pull/1321)); do not wait for or restore translation CI.

- From repo root, with dependencies, workspace build, and authorized API credentials: `pnpm docs:translate`. Default `only-changes` uses commit timestamps; skipping does not prove freshness.
- One page: `pnpm docs:translate -- --mode full --file <source-relative-path>`. All authored index/guides/extensions: `pnpm docs:translate -- --mode full` (excludes generated API references).
- Translation calls APIs and writes locale files. Use `OPENAI_MODEL` overrides only when authorized; CI enforces no model.
- Preserve completed outputs on interruption; report actual command/model, completed/remaining locale-page pairs, recovery wrappers, and corrections. Distinguish CLI runs from exported-function recovery.
- Preserve code, API identifiers, links, canonical heading IDs, and historical aliases. Document narrow MDX/heading corrections and rerun validation; do not replace generated prose ad hoc.
- Review/format locale diffs; run `git diff --check`, `pnpm docs:build`, applicable snippet/generator checks, and independent review for changed technical meaning. Report actual/partial coverage and validation; time unreleased translations to their release.

### Work Status Reporting

- `RUNNING`: commentary only; autonomous work remains, no user action needed.
- `COMPLETE`: final only after requested work, review, verification, and handoff.
- `NEEDS_DECISION`: final only for a specific choice, authority gap, or external blocker.
- Never end with “still running” or request generic continuation.

### Git Worktree and Branch Safety

Use the selected checkout and branch, including its dependency tree, without re-requesting permission. Creating or switching branches/worktrees requires explicit authorization for that action in this conversation; implementation/review/test requests and skill recommendations do not provide it. If isolation is needed, explain why and obtain approval first.

### pnpm Safety

Use pnpm in the user's selected checkout without changing worktrees or branches. Do not use `CI=1`, `--force`, or `confirmModulesPurge=false` to bypass an incompatible `node_modules` prompt. Stop and diagnose the pnpm configuration mismatch instead of silently recreating dependencies. Keep machine-specific pnpm store and shell configuration outside the repository.

### Documentation Release Timing

Determine documentation necessity separately from delivery timing. Required `docs/` describing behavior unavailable in the latest published release belongs in a separate docs-only PR timed to that release; record it as deferred work, not a missing deliverable or blocking finding. Docs already accurate for released behavior remain in scope. This rule overrides documentation-completeness requirements in reviews, PR guidance, and skills; it does not automatically defer examples or code-level documentation shipped with the API.

### Scope Discipline and Complexity Reset

Implement the smallest supported behavior requested. Reuse existing sources of truth; every new abstraction, state field, compatibility branch, or test permutation needs a requirement, released contract, durable boundary, or verified risk. Constructibility and a released-version reproducer alone do not establish support.

When related findings repeatedly expand the same design, stop adding conditions, group root causes, and reassess the complete diff against the original requirement. A second related finding that adds another compatibility case, protocol hop, or test permutation triggers this reset. Prefer deleting unsupported branch-local machinery or rejecting unsupported inputs before side effects with an existing alternative. Follow `$implementation-strategy` for the detailed reset procedure; preserve released contracts and unrelated user changes.

### ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation. Store each ExecPlan file under `plans/` with a descriptive name, and create the directory if it does not exist. Call out compatibility risk only when the plan changes behavior shipped in the latest release tag or a released/otherwise supported durable format. Do not treat branch-local interface churn or unreleased post-tag changes on `main` as breaking by default; prefer direct replacement over compatibility layers in those cases. Confirm the approach when changes could impact package consumers or durable external data that is already supported outside the current branch.

## Code Review Rules

### Finding threshold and supported scope

- Report runtime defects only with a supported trigger and concrete caller-visible, compatibility, security, persistence, or lifecycle consequence.
- Flag abstractions, state, validation, compatibility/fallbacks, dependencies, or parallel paths lacking a task requirement, released contract, supported durable state, or verified runtime/platform risk. Identify the machinery and smallest safe removal/replacement.
- Flag validation/compatibility/fallbacks/tests for synthetic values without a supported producer, released contract, durable boundary, or actual untrusted-input path causing concrete consequences. TypeScript constructibility, fabricated objects, monkeypatches, and helper calls bypassing public/wire owners do not establish support—including extreme/non-finite numbers and impossible enum/union members unless intentionally supported.
- Do not duplicate public-type exclusions or authoritative provider validation. SDK fail-fast validation requires harm before upstream rejection: irreversible effects, persistent corruption, security/privacy exposure, avoidable billing, repeated resource use, or errors too late/opaque to correct reasonably. Security claims require tracing attacker input through a real trust boundary to the protected outcome.
- Cleaner semantics or symmetry alone are not defects. If evidence selects no contract, require inconsistency with a supported path or established caller expectation.
- Flag new options/callbacks/classes/compatibility branches/parallel paths when a reasonable supported API/composition already meets the exact lifecycle and compatibility requirements. Name it; recommend removal or narrower reuse.
- Compatibility findings require latest-released behavior, an explicit supported public contract, or durable external state/protocol. No shims for unreleased branch-local helpers, same-branch tests, or intentionally unsupported intermediate formats.

### Contract and lifecycle coverage

- Trace every changed public/config/event/serialized/wire value through supported construction, forwarding, adapters, consumption, public imports, and generated surfaces. Check normal/specialized/default/missing/error paths for inconsistent dropping, reshaping, or rejection.
- Require streaming/non-streaming, sync/async, initial/resumed, direct/wrapped, or provider parity only where requirements/contracts demand it; symmetry is insufficient.
- Across awaits, callbacks, retries, reconnects, cancellation, cleanup, and rollback, check whether stale/failing work overwrites, reverts, or disposes survivor-owned state. Report the concrete interleaving and missing ownership/generation/identity/transaction/revalidation/serialization invariant at mutation; sequential happy-path tests are insufficient.
- New failures after acquisition must clean up resources/state and preserve the primary failure. Report concrete leaks, stale state, lost handlers, or survivor corruption; do not assume failed construction/context entry invokes teardown.
- Flag persisted/resumed/serialized/provider/manifest data authorizing host-owned runtime/security/identity/cleanup decisions unless the supported trust boundary grants it. Preserve trusted current configuration; validate before side effects, replay, or resource ownership.

### Test and documentation evidence

- Contract tests must exercise the highest stable caller-visible boundary controlling the result and use independent expectations: requirements, released behavior, worked examples, or baselines. Helper call-shape assertions or implementation-derived expectations are insufficient when another layer owns the outcome.
- Cover representative accepted behavior and intentionally unsupported categories, not every constructible permutation. Concurrency tests control completion order and assert survivor behavior plus final shared state.
- Require docs/examples only for materially false/unsafe/misleading guidance, non-obvious migration/compatibility/constraints/operational warnings, or otherwise unusable features. Optional completeness/discoverability is nonblocking.
- Apply [Documentation Release Timing](#documentation-release-timing) separately from necessity.
- Formatting, lint, full-suite status, commit history, and PR-description quality are readiness conditions, not code findings.

### Review scope

- Review the complete merge-base diff, or latest-release baseline for compatibility—not only incremental fixes. Passing tests do not justify machinery outside the original requirement.
- Findings must concern consequences introduced, exposed, or worsened by the patch. Pre-existing issues qualify when newly reached on supported paths, relied upon for correctness, or made consequential by the change; unrelated cleanup, bugs, optional refactors, and speculative extensibility do not.
- Broader refactors require evidence that a focused fix remains incorrect, unsafe, incompatible, or dependent on observably divergent duplicated sources of truth.

## Project Structure Guide

### Overview

See [CONTRIBUTING.md#repository-structure](CONTRIBUTING.md#repository-structure) for package/directory roles, [README.md](README.md) for installation and overview, and [package.json](package.json) for commands. Packages have their own `package.json`, `src/`, `test/`, and build scripts; examples have their own package/start scripts. Workspace membership lives in `pnpm-workspace.yaml`; TypeScript, Vitest, and ESLint settings live in `tsconfig.json`/`tsc-multi.json`, `vitest.config.ts`, and `eslint.config.mjs`. Shared test utilities are in `helpers/tests/`. Root `pnpm dev` runs package watchers and docs together; `scripts/embedMeta.mts` generates package `src/metadata.ts` before builds.

### Repo Structure & Important Files

- Docs: `pnpm docs:dev` / `pnpm docs:build`. English must name actors, objects, and lifecycle subjects; avoid ambiguous pronouns/slash compression. Preserve API identifiers, SDK terminology, and technical strength for translation. Refresh locales only through [Manual Documentation Translation](#manual-documentation-translation).
- Render TS/TSX only from compilable `examples/docs/` files imported with `?raw`; no ad hoc MDX fences. Changed snippet sources/wiring require `pnpm -F docs-code build-check`. Use prose if an example is not worth maintaining/build-checking. Unused declarations are allowed; never add runtime effects merely to use them.

### Agents Core Runtime Guidelines

Before changing or reviewing a runtime boundary, read the matching entries in [the architecture reference map](.agents/references/README.md), then only the relevant references. The map owns routing for public/package/runtime APIs, Agent/context, runner and item lifecycles, schemas/Zod, conversation/session/RunState ownership, tool identity/execution, MCP, providers, tracing, Realtime, sandbox, and extensions.

- `packages/agents-core/src/run.ts` is the runtime entrypoint; keep it small and focused on orchestration.
- Add new runtime logic under `packages/agents-core/src/runner/`, organized by responsibility, then import into `run.ts`.
- When `run.ts` grows, refactor helpers into `runner/` modules and leave only wiring and composition in `run.ts`.
- Keep `packages/agents-core/src/agent.ts` focused on the Agent class and its type definitions; move helper logic into dedicated modules (for example, `agentToolInput.ts`).
- Keep streaming and non-streaming behavior aligned. New model-output, tool-call, approval, or run-item variants must update every applicable processing, event, replay, persistence, tracing, serialization, and adapter surface.
- Bump released RunState schemas when durable meaning changes; unreleased post-tag versions may be consolidated when no supported snapshot consumer exists.
- Use canonical tool-identity helpers in `toolIdentity.ts` and `tooling.ts`.

### Runtime and Platform Review Checklist

Use this checklist when the touched code is in the relevant area. Add focused regression tests for concrete bugs, but keep this checklist focused on the recurring SDK and OpenAI platform boundaries that tests often miss across alternate paths.

- Responses, Realtime, and MCP changes: check replay/retry safety, streaming and non-streaming parity, API defaults for omitted fields, tool/call/reasoning IDs, approval policy handling, and strict validation behavior.
- Session, RunState, and compaction changes: check serialization/deserialization, resume, OpenAI Conversations sessions, local sessions, session callbacks, public history replay, and storage replacement order. Clear or replace persisted history only after the replacement payload is normalized and validated.
- Sandbox provider changes: treat persisted session state as untrusted, prefer trusted configuration on resume/recreate, verify credential refresh and expiry behavior, separate cleanup from preservation, account for remote timeout operations that can complete late, clean up mount secrets on every failure path, and validate real paths and privileged command environments.
- Provider-specific behavior changes: do not rely only on docs when field names, timeout units, lifecycle defaults, credential behavior, or generated SDK surfaces are involved. Compare docs, generated types, and a small live probe when practical.
- Docs and examples changes: typecheck or otherwise verify sample imports against real package exports. TypeScript and TSX snippets rendered in docs must originate from `examples/docs/` and pass `pnpm -F docs-code build-check`; inline MDX snippets are not an exception. In translated docs, preserve locale-prefixed links and localized anchors.

## Operation Guide

### Prerequisites

Use [CONTRIBUTING.md#prerequisites](CONTRIBUTING.md#prerequisites) for supported Node versions and the pnpm version pinned in `package.json`; `corepack enable` is recommended.

### Development Workflow

Stay in the current checkout and branch unless a Git state change is explicitly authorized. Implement the requested behavior, add meaningful regression coverage, and follow the applicable skills above through local handoff. Commit only when authorized, using Conventional Commits. Never push, open a PR, or otherwise mutate GitHub.

### Testing & Automated Checks

Use focused checks during iteration. Add tests for required behavior and concrete regressions, not to mirror implementation logic. Reuse passing checks for unchanged content; broaden or repeat them only when changes, failures, or unresolved concerns justify it. Run eligible final SDK verification after clean review and documentation checks according to their tiers. `$code-change-verification` owns the required final command sequence, including installation and build barriers; do not run broad builds or type checking merely to begin review. Explicit requests to run a suite outside implementation review remain supported.

- Use `pnpm exec vitest run <path>` for focused tests. See [CONTRIBUTING.md](CONTRIBUTING.md) and root `package.json` for test and development commands.
- For provider-neutral agent workflow tests, prefer `ScriptedModel` over a new mock or fake `Model`. Prefer `ScriptedRealtimeTransport` for Realtime session tests and `scriptedSandboxSession()` for deterministic Sandbox calls. Keep a specialized double only for provider-wire conversion, malformed streams, controlled suspension/concurrency, or exact abort/lifecycle delivery that the scripted utilities cannot preserve; document that boundary in the test.
- Keep machine-specific pnpm configuration outside the repository. Preserve the pnpm safety rules above and do not use watch mode for validation.
- Code style follows `eslint.config.mjs` and Prettier. Do not manually hard-wrap Markdown/MDX prose. Comments must end with a period.
- Integration setup is described in [integration-tests/README.md](integration-tests/README.md). Live API runs require the existing credential and execution permissions; running examples is not implicit in reading their source.
- When editing GitHub Actions, verify the latest stable major versions of official actions before updating pins.
- Evaluate review feedback against the requirement, source, and supported contracts before applying it.

### GitHub-ready Output

For release-readiness reports and text requested for pasting into GitHub (not ordinary chat):

- Return one complete fenced `markdown` block with an outer fence longer than any inner fence; honor requests for unfenced raw text. Do not blockquote or repeat rendered content.
- Use valid GitHub Markdown without Codex URIs/directives, citation markers, or nested/double-escaped links. Keep host-required annotations outside the artifact.
- Use repository-relative inline-code paths, never absolute/local-file links; omit paths when requested and name components instead.
- Use native `#123` references for this repo and `owner/repo#123` for others, preserving `Fixes`/`Resolves`. Do not link or qualify same-repo references. Use descriptive links for external resources or targets without native references.
- Inspect literal copied text for intact identifiers, references, and URL targets; remove app wrappers/local paths and rebuild corrupted links from their original targets. Formatting-only reissues preserve reviewed commits/conclusions and do not imply fresh review.

### Pull Request & Commit Guidelines

Apply [Test and documentation evidence](#test-and-documentation-evidence), [Documentation Release Timing](#documentation-release-timing), and the changeset skill trigger above. Add focused regression tests for accepted new behavior when feasible.

Use Conventional Commits: `<type>(<scope>): <short summary>`, optional body; summary under 80 characters. Types: `feat` (feature), `fix` (bug), `docs`, `test`, `chore` (tooling/build/CI), `perf`, `refactor` (no feature/fix), `build`, `ci`, `style`, `types`, `revert`. Add changesets with `pnpm changeset`.
