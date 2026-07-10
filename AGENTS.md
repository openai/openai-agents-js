# Contributor Guide

This guide helps new contributors get started with the OpenAI Agents JS monorepo. It covers repo structure, how to test your work, available utilities, file locations, and guidelines for commits and PRs.

**Location:** `AGENTS.md` at the repository root.

## Table of Contents

1.  [Policies & Mandatory Rules](#policies--mandatory-rules)
2.  [Project Structure Guide](#project-structure-guide)
3.  [Operation Guide](#operation-guide)

## Policies & Mandatory Rules

### Mandatory Skill Usage

#### `$code-change-verification`

Run `$code-change-verification` before marking work complete when changes affect runtime code, tests, or build/test behavior.

Run it when you change:

- `packages/`, `examples/`, `helpers/`, `scripts/`, or `integration-tests/`
- Root build/test config such as `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.*`, or `vitest*.ts`

You can skip `$code-change-verification` for docs-only or repo-meta changes (for example, `docs/`, `.agents/`, `README.md`, `AGENTS.md`, `.github/`), unless a user explicitly asks to run the full verification stack.

#### `$changeset-validation`

When you change anything under `packages/` or touch `.changeset/`, use `$changeset-validation` to create and validate the changeset before you treat the code as final. Codex must ensure an appropriate changeset exists that covers every changed package, and run this skill alongside `$code-change-verification` ahead of handoff. When writing the changeset summary, use a Conventional Commit-style message (for example, `fix: ...` or `feat: ...`) so it can serve as a commit title.

#### `$openai-knowledge`

When working on OpenAI API or OpenAI platform integrations in this repo (Responses API, tools, streaming, Realtime API, auth, models, rate limits, MCP, Agents SDK/ChatGPT Apps SDK), use `$openai-knowledge` to pull authoritative docs via the OpenAI Developer Docs MCP server (and guide setup if it is not configured).

#### `$implementation-strategy`

Before changing runtime code, exported APIs, external configuration, persisted schemas, wire protocols, or other user-facing behavior, use `$implementation-strategy` to decide the compatibility boundary and implementation shape. Judge breaking changes against the latest release tag, not unreleased branch-local churn. Interfaces introduced or changed after the latest release tag may be rewritten without compatibility shims unless they already have a released or otherwise supported durable-state consumer, or the user explicitly asks for a migration path.

#### `$pr-draft-summary`

Before sending the final response for a task, inspect the actual task diff. If it includes runtime code, tests, examples, build/test configuration, or docs with behavior impact, invoke `$pr-draft-summary` to generate the required PR summary block, branch suggestion, title, and draft description. This is a mandatory close-out gate regardless of the perceived size of the change; do not classify an eligible runtime, test, example, or build/test configuration change as trivial. Run it after any required `$code-change-verification` and `$changeset-validation` work.

Skip `$pr-draft-summary` only when no eligible files changed, every change is limited to repo metadata or docs without behavior impact, the task is conversation-only, or the user explicitly says not to include the PR draft block.

### Shared Checkout and pnpm Safety

Treat the primary Git worktree as the user's interactive checkout. A Codex session must not run `pnpm`, or a command that can invoke `pnpm`, from that checkout unless the user explicitly approves sharing its dependency tree in the same turn. This includes read-looking commands such as `pnpm exec`, because pnpm can run a dependency status check and reinstall `node_modules` before executing the requested binary.

Before the first pnpm command, compare `git rev-parse --path-format=absolute --git-dir` with `git rev-parse --path-format=absolute --git-common-dir`:

- If the paths are equal, Codex is in the primary worktree. Move the task to a linked worktree before running pnpm.
- If the paths differ, Codex is in a linked worktree and may use its independent `node_modules`.
- If work has already started in the primary worktree, do not purge or reinstall its dependencies. Transfer the task changes to a linked worktree, or ask the user before using the explicit `CODEX_ALLOW_SHARED_PNPM=1` escape hatch.

In a Codex linked worktree, remove Codex-specific `PNPM_CONFIG_MINIMUM_RELEASE_AGE` and `pnpm_config_minimum_release_age` overrides so `pnpm-workspace.yaml` remains authoritative, and set `CI=1` for non-interactive verification. Do not set `confirmModulesPurge=false` repo-wide and do not add `CI=1` to Husky as a workaround; either change would allow a Git hook to remove the user's shared `node_modules` without confirmation.

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
- `docs/`: Documentation source; develop with `pnpm docs:dev` or build with `pnpm docs:build`. Translated docs under `docs/src/content/docs/ja`, `docs/src/content/docs/ko`, and `docs/src/content/docs/zh` are generated via `pnpm docs:translate`; do not edit them manually.
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

1.  Sync with `main` (or default branch).
2.  Create a feature/fix branch with a descriptive name:
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

### Review Process & What Reviewers Look For

- ✅ All automated checks pass (build, tests, lint).
- ✅ Tests cover new behavior and edge cases.
- ✅ Code is readable and maintainable.
- ✅ Public APIs have doc comments.
- ✅ Examples updated if behavior changes.
- ✅ Documentation (in `docs/`) updated for user-facing changes.
- ✅ Commit history is clean and follows Conventional Commits.
