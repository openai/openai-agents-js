# Contributor Guide

This guide helps new contributors get started with the OpenAI Agents JS monorepo. It covers repo structure, how to test your work, available utilities, file locations, and guidelines for commits and PRs.

**Location:** `AGENTS.md` at the repository root.

## Table of Contents

1.  [Policies & Mandatory Rules](#policies--mandatory-rules)
2.  [Project Structure Guide](#project-structure-guide)
3.  [Operation Guide](#operation-guide)
4.  [Code Review Rules](#code-review-rules)

## Policies & Mandatory Rules

### Mandatory Skill Usage

Repository skills are stored under `.agents/skills/`. A reference such as `$<skill-name>` in this file is a repository instruction reference, not a request for manual user invocation. When a rule requires a skill, read `.agents/skills/<skill-name>/SKILL.md` completely before taking task actions, follow its instructions, and resolve referenced files relative to that skill directory.

#### `$code-change-verification`

Run `$code-change-verification` before marking work complete when changes affect runtime code, tests, or build/test behavior.

Run it when you change:

- `packages/`, `examples/`, `helpers/`, `scripts/`, or `integration-tests/`
- Root build/test config such as `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.*`, or `vitest*.ts`

You can skip `$code-change-verification` for docs-only or repo-meta changes (for example, `docs/`, `.agents/`, `README.md`, `AGENTS.md`, `.github/`), unless a user explicitly asks to run the full verification stack.

Treat `$code-change-verification` as the post-review final gate, not as an iterative review check. When `$implementation-final-review` applies, satisfy its clean-review condition before starting the repository-wide install, build, lint, typecheck, test, examples, integration, and format-check stack. Immediately before starting that stack, use available read-only task or process evidence to check for another broad test, typecheck, build, examples, or integration command already running on the same host. When concrete contention is visible, keep making progress on review, remediation, evidence preparation, or focused checks and defer the broad stack until capacity is available. Do not add a repository lock, host-wide mutex, sentinel file, or user-triggered `finalize` step. Lack of host telemetry alone is not a blocker.

#### `$changeset-validation`

When you change anything under `packages/` or touch `.changeset/`, use `$changeset-validation` to create and validate the changeset before you treat the code as final. Codex must ensure an appropriate changeset exists that covers every changed package, and run this skill alongside `$code-change-verification` ahead of handoff. When writing the changeset summary, use a Conventional Commit-style message (for example, `fix: ...` or `feat: ...`) so it can serve as a commit title.

#### `$openai-knowledge`

When working on OpenAI API or OpenAI platform integrations in this repo (Responses API, tools, streaming, Realtime API, auth, models, rate limits, MCP, Agents SDK/ChatGPT Apps SDK), use `$openai-knowledge` to pull authoritative docs via the OpenAI Developer Docs MCP server (and guide setup if it is not configured).

#### `$implementation-strategy`

Before changing or reviewing runtime code, exported APIs, external configuration, persisted schemas, wire protocols, or other user-facing behavior, use `$implementation-strategy` to decide the compatibility boundary and implementation shape. Before coding, write an implementation scope contract that states the required behavior, compatibility requirements, intentionally unsupported cases and their failure behavior, and an already-supported alternative for those cases or that none exists. Treat this contract as a short, updateable engineering decision record, not as a new public API promise. During review, use the skill before requesting compatibility layers, migrations, new abstractions, or broader refactors.

Repeat the skill before editing each new review-feedback batch; an earlier strategy decision is stale when a comment would widen the supported contract or add another compatibility branch, resolver condition, or test permutation. Judge breaking changes against the latest release tag, not unreleased branch-local churn. Interfaces introduced or changed after the latest release tag may be rewritten without compatibility shims unless they already have a released or otherwise supported durable-state consumer, or the user explicitly asks for a migration path.

An independent reviewer dispatched by `$implementation-final-review` must not invoke `$implementation-strategy` again when its complete reviewer packet contains the parent-prepared implementation scope contract, current compatibility boundary, and resolved base. For that read-only review, the parent invocation satisfies the strategy preparation requirement; the reviewer validates the supplied contract against the complete diff and reports a missing or inconsistent packet instead of reconstructing the workflow. This exception does not apply to the implementer or to a reviewer asked to propose a widened contract.

#### `$implementation-final-review`

After implementing runtime code, tests, examples, build/test behavior, or behavior-impacting docs and completing focused tests, run `$implementation-final-review` before final `$changeset-validation`, `$code-change-verification`, and `$pr-draft-summary` work and before declaring the task complete. Do not start repository-wide lint, typecheck, tests, builds, examples, integration suites, or format checks while the independent review is incomplete or finding-bearing. This repository instruction authorizes automatic invocation without a separate user mention. Do not invoke it for planning, investigation, review, or report-only tasks, repo-meta changes, or docs without behavior impact. The skill's clean-review gate does not replace any other mandatory repository skill or verification gate.

#### `$pr-draft-summary`

Before sending the final response for a task, inspect the actual task diff. If it includes runtime code, tests, examples, build/test configuration, or docs with behavior impact, invoke `$pr-draft-summary` to generate the required PR summary block, branch suggestion, title, and draft description. This is a mandatory close-out gate regardless of the perceived size of the change; do not classify an eligible runtime, test, example, or build/test configuration change as trivial. Run it after any required `$code-change-verification` and `$changeset-validation` work.

Skip `$pr-draft-summary` only when no eligible files changed, every change is limited to repo metadata or docs without behavior impact, the task is conversation-only, or the user explicitly says not to include the PR draft block.

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

### Scope Discipline and Complexity Reset

- Implement the narrowest explicitly stated set of behaviors that satisfies the request. Do not interpret every shape accepted by TypeScript structural typing, an overloaded or generic API, or a third-party interface unless those shapes are required by the task or supported behavior shipped in the latest release.
- Prefer adapting the required case into an existing pipeline over creating a parallel contract, resolver, conversion path, or source of truth. Continue to derive schema, validation, identity, documentation, package exports, and invocation from the existing source-of-truth functions, types, or modules.
- Every new abstraction, state field, cached classification, compatibility branch, or dispatch mode must map to a stated requirement, released contract, supported durable boundary, or verified runtime risk. Remove it if that mapping cannot be stated concretely.
- Treat a second related review finding that would add another condition, protocol hop, compatibility case, or test permutation to the same abstraction as a mandatory complexity-reset checkpoint, not another item to patch. Continue the design only when concrete evidence shows that the additional case belongs to the supported contract.
- When that signal appears, stop extending the current design. Re-read the original requirement, group all findings by root cause, compare the complete diff with the merge base of the intended target branch or with the latest release tag when it is the compatibility baseline, and replace branch-local machinery with a narrower contract. Existing unreleased code and tests are not sunk costs. Perform this reset proactively; do not wait for the user or reviewer to request it.
- A released-version reproducer proves reachability, not a supported contract. Verify the exact shape against documentation, tests, examples, intentional public typing, explicit maintainer intent, or concrete user reliance before adding compatibility machinery.
- Prefer an actionable error during construction or validation, before a model/tool request, persisted mutation, or other side effect, and an existing supported alternative (for example an explicit function wrapper, typed adapter, configuration, or lower-level API) over partially emulating a broad interface. Do not add another alternative when an adequate supported one already exists.
- A growing diff is not itself proof of overengineering, but unexpected cross-package spread, duplicated metadata, combinatorial tests, or repeated special cases requires restarting the design review from the original requirement before more code is added.
- Before handoff, verify that the patch has one source of truth per concern, tests the required behavior and intentionally unsupported cases, and does not accidentally make every constructible type or runtime combination part of the supported SDK behavior.

### ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation. Store each ExecPlan file under `plans/` with a descriptive name, and create the directory if it does not exist. Call out compatibility risk only when the plan changes behavior shipped in the latest release tag or a released/otherwise supported durable format. Do not treat branch-local interface churn or unreleased post-tag changes on `main` as breaking by default; prefer direct replacement over compatibility layers in those cases. Confirm the approach when changes could impact package consumers or durable external data that is already supported outside the current branch.

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
- Docs and examples changes: typecheck or otherwise verify sample imports against real package exports. In translated docs, preserve locale-prefixed links and localized anchors.

## Operation Guide

### Prerequisites

- Node.js 22+ recommended.
- pnpm 10+ (`corepack enable` is recommended to manage versions).

### Development Workflow

1.  Stay in the user's current checkout and on the current branch unless the user explicitly asks for or approves a Git state change.
2.  If the user explicitly requests a feature/fix branch, create one with a descriptive name:
    ```bash
    git checkout -b feat/<short-description>
    ```
3.  Make changes and add/update unit tests in `packages/<pkg>/test` unless doing so is truly infeasible.
4.  Run `pnpm -r build-check` early to catch TypeScript errors across packages, tests, and examples.
5.  When `$code-change-verification` applies (see Mandatory Skill Usage), run it to execute the full verification stack with the skill-defined phase barriers before considering the work complete.
6.  Commit using Conventional Commits.
7.  Push and open a pull request.
8.  Before reporting eligible changes as complete, inspect the actual task diff and invoke `$pr-draft-summary` as the mandatory final handoff step unless the task falls under the documented skip cases.

### Testing & Automated Checks

Before submitting changes, ensure all checks pass and augment tests when you touch code:

When `$code-change-verification` applies (see Mandatory Skill Usage), invoke it to run the required verification stack from the repository root. Rerun the full stack after fixes.

- Add or update unit tests for any code change unless it is truly infeasible; if something prevents adding tests, explain why in the PR.

#### Build and Type Checking

- Always run the full build first to validate the latest build outputs:
  ```bash
  pnpm build
  ```
  NEVER USE `-w` or other watch modes.
- Run this early to catch TypeScript errors in packages, tests, and examples:
  ```bash
  pnpm -r build-check
  ```

#### Unit Tests

- Run the full test suite:
  ```bash
  CI=1 pnpm test
  ```
- Tests are located under each package in `packages/<pkg>/test/`.
- The test script already sets `CI=1` to avoid watch mode.

#### Integration Tests

- Not required for typical contributions. These tests rely on a local npm registry (Verdaccio) and other environment setup.
- To run locally only if needed:
  ```bash
  pnpm local-npm:start   # starts Verdaccio on :4873
  pnpm local-npm:publish # public packages to the local repo
  pnpm test:integration  # runs integration tests
  ```

See [this README](integration-tests/README.md) for details.

#### Code Coverage

- Generate coverage report:
  ```bash
  pnpm test:coverage
  ```
- Reports output to `coverage/`.

#### Linting & Formatting

- Run ESLint:
  ```bash
  pnpm lint
  ```
- Code style follows `eslint.config.mjs` and Prettier defaults.
- Markdown / MDX prose should not be manually hard-wrapped; keep paragraphs unwrapped and let Prettier formatting decide line breaks.
- Comments must end with a period.

#### Build Details

- Build runs `tsx scripts/embedMeta.ts` (prebuild) and `tsc` for each package.

#### Mandatory Local Run Order

When `$code-change-verification` applies (see Mandatory Skill Usage), run the full validation sequence locally via the `$code-change-verification` skill; do not skip any step, and preserve the skill-defined barriers (`pnpm i --frozen-lockfile`, `pnpm build`, then the remaining validation steps).

Before opening a pull request, always run `$changeset-validation` to ensure all changed packages are covered by a changeset and the validation passes; if no packages were touched and a changeset is unnecessary, you can skip creating one.

#### Pre-commit Hooks

- You can skip failing precommit hooks using `--no-verify` during commit.

### Utilities & Tips

- `pnpm dev`: Runs concurrent watch builds for all packages and starts the docs dev server.
  ```bash
  pnpm dev
  ```
- Documentation site:
  ```bash
  pnpm docs:dev
  pnpm docs:build
  ```
- Examples:
  ```bash
  pnpm examples:basic
  pnpm examples:agents-as-tools
  pnpm examples:deterministic
  pnpm examples:tools-shell
  pnpm examples:tools-apply-patch
  # See root package.json "examples:*" scripts for full list
  ```
- Metadata embedding (prebuild):
  ```bash
  pnpm -F <package> build
  # runs embedMeta.ts automatically
  ```
- Workspace scoping (operate on a single package):
  ```bash
  pnpm -F agents-core build
  pnpm -F agents-openai test
  ```
- Use `pnpm -F <pkg>` to operate on a specific package.
- Study `vitest.config.ts` for test patterns (e.g., setup files, aliasing).
- Explore `scripts/embedMeta.ts` for metadata generation logic.
- Examples in `examples/` are fully functional apps—run them to understand usage.
- Docs in `docs/src/` use Astro and Starlight; authored content lives under `docs/src/content/docs/` and mirrors package APIs.
- When editing GitHub Actions workflows, always web-search for the latest stable major versions of official actions (e.g., `actions/checkout`, `actions/setup-node`) before updating version pins.
- Treat review feedback critically: reviewers can be wrong. Reproduce or verify each comment, cross-check with source docs, and only make changes when the feedback remains valid after your own validation.

### Pull Request & Commit Guidelines

- In copy-ready GitHub text, use native issue and pull-request references: exactly `#123` for this repository and `owner/repo#123` for another repository. Do not qualify same-repository references as `openai/openai-agents-js#123`. Preserve closing forms such as `Fixes #123` or `Resolves #123`. Never wrap these references in Markdown links such as `[PR #123](https://github.com/owner/repo/pull/123)` or `[#123](...)`; those Codex-friendly links require manual cleanup after pasting into GitHub. Use descriptive Markdown links only for external resources or GitHub targets that cannot be expressed as a native issue or pull-request reference.
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

## Code Review Rules

- Use `$implementation-strategy` to establish the requested outcome and latest released compatibility boundary before judging implementation scope or architecture.
- Treat added complexity as an actionable finding only when specific machinery is not required by the task, a released contract, supported durable state, or a verified runtime or platform risk. Identify the unnecessary machinery and recommend the smallest safe removal or direct replacement.
- Do not request speculative abstractions, general-purpose helpers, configuration knobs, dependencies, compatibility layers, feature flags, parallel code paths, or extensibility for hypothetical future consumers.
- Do not process a sequence of related review comments as independent local fixes when they expose the same missing boundary. Classify them together, decide whether the disputed shapes belong to the supported contract, and prefer one narrowing redesign over accumulating branches.
- Review the complete diff from the merge base of the intended target branch, or from the latest release tag when it is the compatibility baseline, not only the latest incremental fix. Passing tests do not justify branch-local machinery that no longer matches the original requirement.
- Keep findings scoped to the patch. Do not block on unrelated cleanup, pre-existing bugs, or optional refactors; report them separately when useful.
- Require a broader refactor only when concrete evidence shows the focused change would otherwise be incorrect, unsafe, incompatible, or materially harder to maintain.

### Baseline review expectations

- ✅ All automated checks pass (build, tests, lint).
- ✅ Tests cover new behavior and edge cases.
- ✅ Code is readable and maintainable.
- ✅ Examples updated if behavior changes.
- ✅ Documentation (in `docs/`) updated for user-facing changes, except unreleased-behavior documentation that must follow the separate docs-only pull request policy above.
- ✅ Commit history is clean and follows Conventional Commits.
