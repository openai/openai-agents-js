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

You can skip `$code-change-verification` for docs-only or repo-meta changes (for example, `docs/`, `.codex/`, `README.md`, `AGENTS.md`, `.github/`), unless a user explicitly asks to run the full verification stack.

#### `$changeset-validation`

When you change anything under `packages/` or touch `.changeset/`, use `$changeset-validation` to create and validate the changeset before you treat the code as final. Codex must ensure an appropriate changeset exists that covers every changed package, and run this skill alongside `$code-change-verification` ahead of handoff. When writing the changeset summary, use a Conventional Commit-style message (for example, `fix: ...` or `feat: ...`) so it can serve as a commit title.

#### `$openai-knowledge`

When working on OpenAI API or OpenAI platform integrations in this repo (Responses API, tools, streaming, Realtime API, auth, models, rate limits, MCP, Agents SDK/ChatGPT Apps SDK), use `$openai-knowledge` to pull authoritative docs via the OpenAI Developer Docs MCP server (and guide setup if it is not configured).

### ExecPlans

When writing complex features or significant refactors, use an ExecPlan (as described in PLANS.md) from design to implementation. Store each ExecPlan file in the repository root (top level) with a descriptive name.
Call out potential backward compatibility or public API risks in your plan and confirm the approach when changes could impact package consumers.

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
- `README.md`: High-level overview and installation instructions.
- `CONTRIBUTING.md`: Official contribution guidelines (this guide is complementary).
- `pnpm-workspace.yaml`: Defines workspace packages.
- `tsconfig.json`, `tsc-multi.json`: TypeScript configuration.
- `vitest.config.ts`: Test runner configuration.
- `eslint.config.mjs`: ESLint configuration.
- `package.json` (root): Common scripts (`build`, `test`, `lint`, `dev`, `docs:dev`, `examples:*`).

### Agents Core Runtime Guidelines

- `packages/agents-core/src/run.ts` is the runtime entrypoint; keep it small and focused on orchestration.
- Add new runtime logic under `packages/agents-core/src/runner/`, organized by responsibility, then import into `run.ts`.
- When `run.ts` grows, refactor helpers into `runner/` modules and leave only wiring and composition in `run.ts`.
- Keep streaming and non-streaming loops behaviorally aligned; changes to one loop should be mirrored in the other.
- Input guardrails run only on the first turn; interruption resumes should not increment the turn counter.
- When `conversationId`/`previousResponseId` is provided, only deltas are sent; `callModelInputFilter` must return an input array and keep session persistence in sync.
- Adding new tool/output/approval item types requires coordinated updates across model output processing, tool execution, turn resolution, streaming events, run item extraction, and RunState serialization.
- If serialized RunState shape changes, bump the schema version and update serialization/deserialization.

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
5.  When `$code-change-verification` applies (see Mandatory Skill Usage), run it to execute the full verification stack in order before considering the work complete.
6.  Commit using Conventional Commits.
7.  Push and open a pull request.
8.  When reporting code changes as complete (after substantial code work), invoke `$pr-draft-summary` to generate the required PR summary block with change summary, PR title, and draft description.

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
  pnpm local-npm:publish # public pacakges to the local repo
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
- Comments must end with a period.

#### Build Details

- Build runs `tsx scripts/embedMeta.ts` (prebuild) and `tsc` for each package.

#### Mandatory Local Run Order

When `$code-change-verification` applies (see Mandatory Skill Usage), run the full validation sequence locally via the `$code-change-verification` skill; do not skip any step or change the order.

Before opening a pull request, always run `$changeset-validation` to ensure all changed packages are covered by a changeset and the validation passes; if no packages were touched and a changeset is unnecessary, you can skip creating one.

#### Pre-commit Hooks

- You can skip failing precommit hooks using `--no-verify` during commit.

### Utilities & Tips

- `pnpm dev`:
  Runs concurrent watch builds for all packages and starts the docs dev server.
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
