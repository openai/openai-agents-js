# Contributor Guide

This guide helps new contributors get started with the OpenAI Agents JS monorepo. It covers repo structure, how to test your work, available utilities, file locations, and guidelines for commits and PRs.

**Location:** `AGENTS.md` at the repository root.

## Table of Contents

1.  [Policies & Mandatory Rules](#policies--mandatory-rules)
2.  [Code Review Rules](#code-review-rules)
3.  [Project Structure Guide](#project-structure-guide)
4.  [Operation Guide](#operation-guide)

## Policies & Mandatory Rules

### Mandatory Skill Usage

Repository skills are stored under `.agents/skills/`. References below authorize their use when the stated condition applies; no separate manual invocation is needed unless explicitly required. Read the selected `SKILL.md`, then only the supporting references needed for its route. User instructions and already-approved scope take precedence over skill defaults, subject to applicable permissions. Do not repeat approval already given for local implementation, review, or verification.

- **`$implementation-strategy`:** Use before changing or reviewing SDK runtime behavior, public APIs, configuration, persisted schemas, or wire protocols. Record required behavior, compatibility, unsupported cases, and an existing alternative in a short scope contract. Revisit it when feedback changes the contract or implementation shape. Independent reviewers inherit that contract and report uncertainty instead of rerunning strategy.
- **`$implementation-final-review`:** After focused checks, use for runtime code, tests, examples, build/test behavior, and behavior-impacting docs. Its entrypoint owns the lightweight/ordinary/high-risk classification: behavior changes normally require independent review; only demonstrably non-semantic changes can omit it. Finish required review before broad final checks. Planning, investigation, and report-only tasks do not invoke this workflow. Repo-meta changes use applicable skill validation; implementing changes to decision-making guidance requires realistic scenario checks and an independent pass. Report-only assessments can use existing evidence without starting an implementation review.
- **`$code-change-verification`:** Run the final SDK stack for changes under `packages/`, `examples/`, `helpers/`, `scripts/`, or `integration-tests/`, and root build/test configuration such as `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `tsc-multi.json`, `eslint.config.*`, or `vitest*.ts`. Docs-only and repo-meta changes can skip it unless they affect build/test behavior or the user requests the full stack. Lightweight review does not waive eligible SDK checks. The skill owns command order, sandbox execution, host-capacity checks, and retry rules.
- **`$changeset-validation`:** When anything under `packages/` or `.changeset/` changes, create and validate an appropriate changeset covering every changed package before handoff. Use a Conventional Commit-style summary such as `fix: ...` or `feat: ...`. Complete final validation after required review, alongside `$code-change-verification`.
- **`$openai-knowledge`:** Use when OpenAI API/platform behavior needs authoritative external evidence. Inspect local code for SDK-owned behavior; do not repeat unchanged external research for purely local implementation details.
- **`$pr-draft-summary`:** After applicable review, changeset validation, and verification, generate the local PR draft for runtime code, tests, examples, build/test changes, or behavior-impacting docs, including uncommitted work. Skip repo-meta or docs without behavior impact, conversation-only tasks, or an explicit user opt-out. An explicit request for a draft takes precedence over automatic-trigger exclusions. A draft never authorizes a branch, commit, push, or PR creation.

Continue authorized local work through fixes, applicable review, verification, and handoff. Stop for a concrete unresolved contract or scope decision, missing authority, or an external blocker. When a skill causes a stop, identify the exact instruction and explain the missing decision; do not ask for a generic continuation prompt. Never push, open a PR, or otherwise mutate GitHub.

### Documentation Change Verification Tiers

Classify the complete task-owned diff, including committed, staged, unstaged, and task-owned untracked files, by the highest applicable documentation risk tier. This section is the source of truth for documentation-specific verification; skills that edit or audit docs must reference these tiers instead of defining a second verification policy. These tiers add focused documentation checks only. They do not change the existing eligibility rules for `$implementation-final-review`, `$code-change-verification`, `$changeset-validation`, or `$pr-draft-summary`.

- **Editorial**: Changes only spelling, grammar, punctuation, formatting, or wording that preserves the exact technical meaning. The complete diff must not change technical claims, links, anchors, frontmatter, snippets, snippet imports, navigation, Astro configuration, or generators. Run `git diff --check` and Prettier check for the changed Markdown or MDX files. Skip `pnpm docs:build`, `pnpm -F docs-code build-check`, and independent behavior review unless another changed path or existing eligibility rule requires them.
- **Content**: Changes technical claims, API names, defaults, behavior descriptions, links, anchors, frontmatter, snippet imports, rendered snippet wiring, or TypeScript/TSX sources under `examples/docs/`. Verify every changed claim against the implementation or another authoritative source, and write authored English that explicitly names actors, objects, and lifecycle subjects for reliable translation. Run `git diff --check` and Prettier check for the changed authored docs and snippet files. When the diff changes a rendered TypeScript/TSX snippet source or its MDX import/rendering, run `pnpm -F docs-code build-check`. Skip `pnpm docs:build` when the diff has no Structural change.
- **Structural**: Changes documentation navigation, routes, page layout, `docs/astro.config.mjs`, sidebar configuration, docs build configuration, or documentation and translation generators such as `docs/src/scripts/**`. Run the applicable Content checks, `pnpm docs:build`, and `pnpm docs:scripts:check` when `docs/src/scripts/**` changes. Do not run `pnpm docs:translate` as routine verification and do not hand-edit generated translations.

For every tier, update only authored English docs. Do not edit generated translations under `docs/src/content/docs/ja`, `docs/src/content/docs/ko`, or `docs/src/content/docs/zh`. TypeScript and TSX rendered in docs must continue to live under `examples/docs/`, be imported into MDX with `?raw`, and pass `pnpm -F docs-code build-check` whenever the complete diff changes that snippet source or wiring. If the complete diff also contains runtime code, tests, examples, build/test behavior, behavior-impacting docs, package files, or changesets, run every broader repository gate already required for those paths.

### Work Status Reporting

- Use `RUNNING` only in commentary while autonomous work remains and no user action is required. Do not end a turn with a final response that says the task is still running or asks the user to send a generic continuation prompt.
- Use `COMPLETE` in the final response only when the requested work and every applicable review, verification, and local handoff step are complete.
- Use `NEEDS_DECISION` in the final response only when progress requires a concrete user choice, expanded authority, or an unresolved external condition. State the exact decision or condition instead of asking the user to say "continue".

### Git Worktree and Branch Safety

Work in the user's current checkout and on the current branch by default. If the Codex task is already running in a selected Git worktree or primary checkout, use that checkout without requesting additional permission, including for commands that operate on its dependency tree. Do not create or switch to another Git worktree, and do not create or switch branches, unless the user explicitly asks for or approves that exact action in the current conversation. A request to implement, investigate, review, test, or verify changes does not by itself authorize changing the active worktree or branch.

If isolation or a different checkout is needed, explain why and ask the user before changing Git state. This requirement also applies when another rule or workflow recommends a linked worktree: stop and request approval instead of choosing or creating one automatically.

### pnpm Safety

Use pnpm in the user's selected checkout without changing worktrees or branches. Do not use `CI=1`, `--force`, or `confirmModulesPurge=false` to bypass an incompatible `node_modules` prompt. Stop and diagnose the pnpm configuration mismatch instead of silently recreating dependencies. Keep machine-specific pnpm store and shell configuration outside the repository.

### Documentation Release Timing

When a feature or bug fix introduces behavior that is not yet available in the latest published release, do not include `docs/` changes that describe that unreleased behavior in the feature or bug-fix pull request, and do not expect those changes as part of that pull request. Handle them in a separate docs-only pull request so maintainers can coordinate its merge timing with the release that makes the documentation accurate. This exception applies only when the documentation would be incorrect for the latest published release; documentation that is already accurate for released behavior remains part of the normal change scope.

Determine whether documentation is required separately from deciding which pull request should carry it. When required `docs/` content would describe behavior that is not available in the latest published release, classify it as separately timed documentation work rather than a missing deliverable or blocking finding for the feature or bug-fix pull request. This timing rule takes precedence over general documentation-completeness requirements in code-review rules, pull-request guidance, and repository skills. It applies to `docs/` content, not automatically to examples or code-level documentation that ships with the changed API.

### Scope Discipline and Complexity Reset

Implement the smallest supported behavior requested. Reuse existing sources of truth; every new abstraction, state field, compatibility branch, or test permutation needs a requirement, released contract, durable boundary, or verified risk. Constructibility and a released-version reproducer alone do not establish support.

When related findings repeatedly expand the same design, stop adding conditions, group root causes, and reassess the complete diff against the original requirement. A second related finding that adds another compatibility case, protocol hop, or test permutation triggers this reset. Prefer deleting unsupported branch-local machinery or rejecting unsupported inputs before side effects with an existing alternative. Follow `$implementation-strategy` for the detailed reset procedure; preserve released contracts and unrelated user changes.

### ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation. Store each ExecPlan file under `plans/` with a descriptive name, and create the directory if it does not exist. Call out compatibility risk only when the plan changes behavior shipped in the latest release tag or a released/otherwise supported durable format. Do not treat branch-local interface churn or unreleased post-tag changes on `main` as breaking by default; prefer direct replacement over compatibility layers in those cases. Confirm the approach when changes could impact package consumers or durable external data that is already supported outside the current branch.

## Code Review Rules

### Finding threshold and supported scope

- Report a runtime defect only when the changed code causes a concrete incorrect behavior on a supported path. State the triggering scenario and the caller-visible, compatibility, security, persistence, or lifecycle consequence; omit the finding when no such consequence can be established.
- Treat added abstractions, state, validation, compatibility handling, fallback behavior, dependencies, or parallel paths as actionable only when the machinery does not map to the task, a released contract, supported durable state, or a verified runtime or platform risk. Identify the exact unnecessary machinery and recommend the smallest safe removal or direct replacement.
- Flag runtime validation, compatibility handling, fallback behavior, or tests added only for synthetic or unsupported values when no ordinary supported producer, released contract, durable boundary, or actual untrusted-input path can produce the value with a concrete consequence. Constructibility through TypeScript structural typing, manually fabricated typed objects, monkeypatched state, and direct helper calls that bypass the owning public or wire boundary are not sufficient justification. This includes non-finite or extreme numbers and impossible enum or discriminated-union members unless the exact category is intentionally supported.
- Do not duplicate client-side runtime validation solely for values already excluded by the public type contract or authoritatively rejected by the upstream provider. Add fail-fast SDK validation only when delayed rejection creates a concrete SDK-owned problem before the authoritative rejection, such as an irreversible side effect, persistent corruption, security or privacy exposure, avoidable billable work, repeated resource consumption, or an error that arrives too late or is too opaque for reasonable correction. A security label alone is insufficient without a complete trace from attacker-controlled input through an actual trust boundary to the protected outcome.
- Do not report a defect merely because another semantic choice appears cleaner, more symmetric, or easier to explain. When repository evidence does not select one contract, report only a concrete inconsistency with an already supported path or an established caller-visible expectation.
- Flag a new public option, callback, class, compatibility branch, or parallel execution path when the exact required outcome, including its lifecycle and compatibility constraints, is already available through a reasonable supported API or composition path. Name that path and recommend removal or narrower reuse of the existing source of truth.
- Report compatibility findings only against behavior shipped in the latest release, an explicitly supported public contract, or a durable external state or protocol boundary. Do not require compatibility shims for unreleased branch-local helpers, same-branch tests, or intermediate persisted formats that are intentionally unsupported.

### Contract and lifecycle coverage

- For every added or modified public field, configuration value, event, serialized value, or wire value, inspect all supported construction, forwarding, adapter, and consumption paths. Flag partial implementations where normal, specialized, default, missing-value, or error paths silently drop, reshape, or reject the value inconsistently. Include intended public imports and generated package surfaces when they are part of the changed contract.
- Require parity across streaming and non-streaming, sync and async, initial and resumed, direct and wrapped, or provider-specific paths only when the accepted requirement or existing contract covers those paths. Do not report missing parity solely for API symmetry or conceptual similarity.
- When changed code mutates shared state across an `await`, callback, retry, reconnect, cancellation, cleanup, or rollback boundary, check whether stale or failing work can overwrite, revert, or dispose state owned by surviving work. Report the concrete interleaving and the missing ownership, generation, identity, transaction, revalidation, or serialization invariant at the actual mutation boundary; sequential happy-path tests are insufficient.
- When a new validation or failure path can run after resources or observable state are acquired, verify cleanup explicitly and preserve the primary failure. Report concrete leaked resources, stale state, lost handlers, or survivor corruption rather than assuming normal teardown runs after failed construction or context entry.
- Flag persisted, resumed, serialized, provider-controlled, or manifest data that is treated as authority for a host-owned runtime, security, identity, or cleanup decision unless the supported trust boundary explicitly grants that authority. Preserve trusted current configuration and validate untrusted state before it can affect side effects, replay, or resource ownership.

### Test and documentation evidence

- Treat tests as contract evidence only when they exercise the highest stable caller-visible boundary that controls the observable result and derive expected behavior from the requirement, released behavior, a worked example, a baseline, or another independent oracle. Do not accept helper-only call-shape assertions or expected values recomputed with the implementation's own logic when another layer owns the outcome.
- Require representative regression coverage for the accepted behavior and intentionally unsupported category. For concurrency findings, require controlled completion ordering plus assertions about the surviving operation and final shared state. Do not request exhaustive tests for every constructible permutation.
- Report missing documentation or examples only when the patch makes existing guidance materially false, unsafe, or misleading; correct use depends on a non-obvious migration, compatibility boundary, constraint, or operational warning; or the accepted feature would otherwise be practically unusable. Do not report optional completeness or discoverability improvements as blocking findings.
- Decide `docs/` delivery timing separately from documentation necessity. If required `docs/` content would describe behavior unavailable in the latest published release, apply [Documentation Release Timing](#documentation-release-timing): record it as separately timed work, and do not report its absence as a blocking finding for the feature or bug-fix pull request. This exception does not automatically defer examples or code-level documentation that ships with the changed API.
- Do not report formatting, lint, full-suite status, commit history, or pull-request description quality as code findings; those are CI or repository-readiness conditions.

### Review scope

- Review the complete diff from the merge base of the intended target branch, or from the latest release tag when it is the compatibility baseline, not only the latest incremental fix. Passing tests do not justify branch-local machinery that no longer matches the original requirement.
- Keep findings scoped to consequences introduced, exposed, or worsened by the patch. Do not block on unrelated cleanup, pre-existing bugs, optional refactors, or speculative extensibility merely discovered while reading adjacent code. A pre-existing condition is in scope when the patch newly reaches it on a supported path, relies on it for correctness, or otherwise makes its consequence part of the changed behavior.
- Require a broader refactor only when concrete evidence shows the focused change would otherwise remain incorrect, unsafe, incompatible, or dependent on duplicated sources of truth that can observably diverge.

## Project Structure Guide

### Overview

The OpenAI Agents JS repository is a pnpm-managed monorepo that provides:

- `packages/agents`: A convenience bundle exporting core and OpenAI packages.
- `packages/agents-core`: Core abstractions and runtime for agent workflows.
- `packages/agents-openai`: OpenAI-specific bindings and implementations.
- `packages/agents-realtime`: Realtime bindings and implementations.
- `packages/agents-extensions`: Extensions for agent workflows.
- `docs`: Documentation site powered by Astro.
- `examples`: Sample projects demonstrating usage patterns.
- `scripts`: Automation scripts (`dev.mts`, `embedMeta.ts`).
- `helpers`: Shared utilities for testing and other internal use.

### Repo Structure & Important Files

- `packages/agents-core/`, `packages/agents-openai/`, `packages/agents-realtime/`, `packages/agents-extensions/`: Each has its own `package.json`, `src/`, `test/`, and build scripts.
- `docs/`: Documentation source; develop with `pnpm docs:dev` or build with `pnpm docs:build`. Write and review authored English source docs for reliable translation: explicitly name actors, objects, and lifecycle subjects; avoid ambiguous pronouns and slash-compressed concepts; preserve exact API identifiers and established SDK terminology; and do not weaken or strengthen technical claims merely to simplify translation. Translated docs under `docs/src/content/docs/ja`, `docs/src/content/docs/ko`, and `docs/src/content/docs/zh` are generated via `pnpm docs:translate`; do not edit them manually.
- Every TypeScript or TSX snippet shown in authored docs must come from a compilable source file under `examples/docs/`, be imported into MDX with `?raw`, and pass `pnpm -F docs-code build-check`. Do not add ad hoc TypeScript or TSX fenced blocks directly to MDX. If an example is not useful enough to maintain and build-check as a complete source file, explain the behavior in prose instead. Do not add artificial runtime side effects, such as `console.log`, solely to mark declarations as used; the `examples/docs/` TypeScript project permits unused declarations so documentation examples can stay focused on the behavior they teach.
- `examples/`: Subdirectories (e.g. `basic`, `agent-patterns`) with their own `package.json` and start scripts.
- `scripts/dev.mts`: Runs concurrent build-watchers and the docs dev server (`pnpm dev`).
- `scripts/embedMeta.ts`: Generates `src/metadata.ts` for each package before build.
- `helpers/tests/`: Shared test utilities.
- `.agents/references/`: Durable SDK maintainer architecture references. Start with [the reference map](.agents/references/README.md) and open only the files relevant to the affected boundary.
- `README.md`: High-level overview and installation instructions.
- `CONTRIBUTING.md`: Official contribution guidelines (this guide is complementary).
- `pnpm-workspace.yaml`: Defines workspace packages.
- `tsconfig.json`, `tsc-multi.json`: TypeScript configuration.
- `vitest.config.ts`: Test runner configuration.
- `eslint.config.mjs`: ESLint configuration.
- `package.json` (root): Common scripts (`build`, `test`, `lint`, `dev`, `docs:dev`, `examples:*`).

### Agents Core Runtime Guidelines

- For public exports, convenience-package re-exports, ESM/CJS/types, optional dependencies, import side effects, or Node/browser/workerd shims, read [Public API, package, and runtime boundaries](.agents/references/public-api-package-and-runtime-boundaries.md).
- For Agent configuration, cloning, dynamic instructions, enabled tools/handoffs, nested agent tools, run context, usage, or public-versus-prepared identity, read [Agent definition and run context](.agents/references/agent-definition-and-run-context.md).
- `packages/agents-core/src/run.ts` is the runtime entrypoint; keep it small and focused on orchestration.
- Add new runtime logic under `packages/agents-core/src/runner/`, organized by responsibility, then import into `run.ts`.
- When `run.ts` grows, refactor helpers into `runner/` modules and leave only wiring and composition in `run.ts`.
- Keep `packages/agents-core/src/agent.ts` focused on the Agent class and its type definitions; move helper logic into dedicated modules (for example, `agentToolInput.ts`).
- For turn accounting, guardrail order, handoffs, interruption, cancellation, hooks, final output, or streaming behavior, read [Runner lifecycle](.agents/references/runner-lifecycle.md). Keep streaming and non-streaming paths behaviorally aligned.
- For new model output, tool call, approval, or run-item variants, read [Run item and stream lifecycle](.agents/references/run-item-and-stream-lifecycle.md) and update every applicable processing, event, replay, persistence, tracing, serialization, and adapter surface.
- For function-tool parameters, structured output, strict JSON Schema conversion, Zod v3/v4, or provider schema conversion, read [Schema and Zod boundaries](.agents/references/schema-and-zod-boundaries.md).
- For `conversationId`, `previousResponseId`, explicit replay, filtering, continuation, compaction strategy, retry, or resume, read [Conversation state ownership](.agents/references/conversation-state-ownership.md).
- For session callbacks, stored input, history mutation, per-turn writes, rollback, or compaction replacement, read [Session persistence](.agents/references/session-persistence.md).
- For serialized RunState, approvals, agent/tool reconstruction, traces, conversation IDs, or sandbox state, read [RunState schema and resume](.agents/references/runstate-schema-and-resume.md). Bump a released schema when its durable meaning changes; unreleased post-tag versions may be folded into the same next schema when no supported snapshot consumer exists.
- For tool names, namespaces, lookup, call IDs, approvals, collisions, deferred tools, MCP names, or trace labels, read [Tool identity and routing](.agents/references/tool-identity-and-routing.md) and use the canonical helpers in `toolIdentity.ts` and `tooling.ts`.
- For tool planning, approvals, guardrails, concurrency, aborts, timeouts, hooks, failure conversion, nested agent tools, or tool-choice reset, read [Tool execution and approval lifecycle](.agents/references/tool-execution-and-approval-lifecycle.md).
- For local MCP connections, stdio/SSE/streamable HTTP, requests, cache/filtering, retries, cancellation, or cleanup, read [MCP transport, cache, and shims](.agents/references/mcp-transport-cache-and-shims.md).
- For model resolution, settings merge, Responses/Chat Completions conversion, provider data, raw events, retries, transport reuse, or Responses WebSocket sessions, read [Model, provider, and conversion boundaries](.agents/references/model-provider-and-conversion-boundaries.md).
- For trace/span context, processors, export, flush, shutdown, resume, runtime storage, usage, or sensitive data, read [Tracing and runtime context](.agents/references/tracing-and-runtime-context.md).
- For Realtime agent/session state, response sequencing, tools, guardrails, history, handoffs, listeners, or cleanup, read [Realtime session lifecycle](.agents/references/realtime-session-lifecycle.md).
- For WebRTC, WebSocket, SIP, Twilio, Cloudflare, connection state, audio formats, transcripts, or Realtime event payloads, read [Realtime transport, audio, and events](.agents/references/realtime-transport-audio-and-events.md).
- For sandbox preparation, sessions, manifests, mounts, path grants, snapshots, credentials, timeout, resume, process execution, or cleanup, read [Sandbox runtime and provider boundaries](.agents/references/sandbox-runtime-and-provider-boundaries.md).
- For AI SDK model/UI adapters, provider metadata, usage, reasoning, tool-call translation, aborts, or stream completion, read [Extension adapter boundaries](.agents/references/extension-adapter-boundaries.md).

### Runtime and Platform Review Checklist

Use this checklist when the touched code is in the relevant area. Add focused regression tests for concrete bugs, but keep this checklist focused on the recurring SDK and OpenAI platform boundaries that tests often miss across alternate paths.

- Responses, Realtime, and MCP changes: check replay/retry safety, streaming and non-streaming parity, API defaults for omitted fields, tool/call/reasoning IDs, approval policy handling, and strict validation behavior.
- Session, RunState, and compaction changes: check serialization/deserialization, resume, OpenAI Conversations sessions, local sessions, session callbacks, public history replay, and storage replacement order. Clear or replace persisted history only after the replacement payload is normalized and validated.
- Sandbox provider changes: treat persisted session state as untrusted, prefer trusted configuration on resume/recreate, verify credential refresh and expiry behavior, separate cleanup from preservation, account for remote timeout operations that can complete late, clean up mount secrets on every failure path, and validate real paths and privileged command environments.
- Provider-specific behavior changes: do not rely only on docs when field names, timeout units, lifecycle defaults, credential behavior, or generated SDK surfaces are involved. Compare docs, generated types, and a small live probe when practical.
- Docs and examples changes: typecheck or otherwise verify sample imports against real package exports. TypeScript and TSX snippets rendered in docs must originate from `examples/docs/` and pass `pnpm -F docs-code build-check`; inline MDX snippets are not an exception. In translated docs, preserve locale-prefixed links and localized anchors.

## Operation Guide

### Prerequisites

- Node.js 22+ recommended.
- pnpm 10+ (`corepack enable` is recommended to manage versions).

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

### Pull Request & Commit Guidelines

- In copy-ready GitHub text, use native issue and pull-request references: exactly `#123` for this repository and `owner/repo#123` for another repository. Do not qualify same-repository references as `openai/openai-agents-js#123`. Preserve closing forms such as `Fixes #123` or `Resolves #123`. Never wrap these references in Markdown links such as `[PR #123](https://github.com/owner/repo/pull/123)` or `[#123](...)`; those Codex-friendly links require manual cleanup after pasting into GitHub. Use descriptive Markdown links only for external resources or GitHub targets that cannot be expressed as a native issue or pull-request reference.
- Add focused regression tests for accepted new behavior when feasible. Update documentation or examples when the change would otherwise make existing guidance materially false, unsafe, or misleading; correct use depends on a non-obvious constraint, migration step, compatibility boundary, or operational warning; or the accepted feature would otherwise be practically unusable. Do not require optional documentation or examples solely for completeness.
- Determine `docs/` delivery timing separately from documentation necessity. When required `docs/` content would describe behavior that is not yet in the latest published release, leave it out of the feature or bug-fix pull request and treat it as separately timed docs-only work, not as an incomplete current pull request. This exception does not automatically apply to examples or code-level documentation that ships with the changed API.
- Use **Conventional Commits**:
  - `feat`: new feature
  - `fix`: bug fix
  - `docs`: documentation only
  - `test`: adding or fixing tests
  - `chore`: build, CI, or tooling changes
  - `perf`: performance improvement
  - `refactor`: code changes without feature or fix
  - `build`: changes that affect the build system
  - `ci`: CI configuration
  - `style`: code style (formatting, missing semicolons, etc.)
  - `types`: type-related changes
  - `revert`: reverts a previous commit
- Commit message format:

  ```
  <type>(<scope>): <short summary>

  Optional longer description.
  ```

- Keep summary under 80 characters.
- If your change affects the public API, add a Changeset via:
  ```bash
  pnpm changeset
  ```
