# Contributor Guide

This guide helps new contributors get started with the OpenAI Agents JS monorepo. It covers repo structure, how to test your work, available utilities, file locations, and guidelines for commits and PRs.

**Location:** `AGENTS.md` at the repository root.

## Table of Contents

1.  [Overview](#overview)
2.  [Repo Structure & Important Files](#repo-structure--important-files)
3.  [Testing & Automated Checks](#testing--automated-checks)
4.  [Repo-Specific Utilities](#repo-specific-utilities)
5.  [Style, Linting & Type Checking](#style-linting--type-checking)
6.  [Development Workflow](#development-workflow)
7.  [Pull Request & Commit Guidelines](#pull-request--commit-guidelines)
8.  [Review Process & What Reviewers Look For](#review-process--what-reviewers-look-for)
9.  [Tips for Navigating the Repo](#tips-for-navigating-the-repo)

## Overview

The OpenAI Agents JS repository is a pnpm-managed monorepo that provides:

- `packages/agents`: A convenience bundle exporting core and OpenAI packages.
- `packages/agents-core`: Core abstractions and runtime for agent workflows.
- `packages/agents-openai`: OpenAI-specific bindings and implementations.
- `packages/agents-realtime`: Realtime bindings and implementations.
- `packages/agents-extensions`: Extensions for agent workflows.
- `docs`: Documentation site powered by Astro.
- `examples`: Sample projects demonstrating usage patterns.
- `scripts`: Automation scripts (`dev.ts`, `embedMeta.ts`).
- `helpers`: Shared utilities for testing and other internal use.

## Repo Structure & Important Files

- `packages/agents-core/`, `packages/agents-openai/`, `packages/agents-realtime/`, `packages/agents-extensions/`: Each has its own `package.json`, `src/`, `test/`, and build scripts.
- `docs/`: Documentation source; run with `pnpm docs:dev` or build with `pnpm -F docs build`.
- `examples/`: Subdirectories (e.g. `basic`, `agent-patterns`) with their own `package.json` and start scripts.
- `scripts/dev.ts`: Runs concurrent build-watchers and the docs dev server (`pnpm dev`).
- `scripts/embedMeta.ts`: Generates `src/metadata.ts` for each package before build.
- `helpers/tests/`: Shared test utilities.
- `README.md`: High-level overview and installation instructions.
- `CONTRIBUTING.md`: Official contribution guidelines (this guide is complementary).
- `pnpm-workspace.yaml`: Defines workspace packages.
- `tsconfig.json`, `tsc-multi.json`: TypeScript configuration.
- `vitest.config.ts`: Test runner configuration.
- `eslint.config.mjs`: ESLint configuration.
- `package.json` (root): Common scripts (`build`, `test`, `lint`, `dev`, `docs:dev`, `examples:*`).

## Testing & Automated Checks

Before submitting changes, ensure all checks pass:

### Unit Tests and Type Checking Examples

- Check the compilation across all packages and examples:
  ```bash
  pnpm -r build-check
  ```
- Run the full test suite:
  ```bash
  CI=1 pnpm test
  ```
- Tests are located under each package in `packages/<pkg>/test/`.
- Using `CI=1` makes sure that the tests don't automatically run in watch mode

### Integration Tests

- Do NOT try to run them. Integration tests currently require a valid OpenAI Account.

### Code Coverage

- Generate coverage report:
  ```bash
  pnpm test:coverage
  ```
- Reports output to `coverage/`.

### Linting & Formatting

- Run ESLint:
  ```bash
  pnpm lint
  ```
- Code style follows `eslint.config.mjs` and Prettier defaults.
- Comments must end with a period.

### Type Checking

- Ensure TypeScript errors are absent via build:
  ```bash
  pnpm build
  ```
- Build runs `tsx scripts/embedMeta.ts` (prebuild) and `tsc` for each package.

### Pre-commit Hooks

- You can skip failing precommit hooks using `--no-verify` during commit.

## Repo-Specific Utilities

- `pnpm dev`:
  Runs concurrent watch builds for all packages and starts the docs dev server.
  ```bash
  pnpm dev
  ```
- Documentation site:
  ```bash
  pnpm docs:dev
  pnpm -F docs build
  ```
- Examples:
  ```bash
  pnpm examples:basic
  pnpm examples:agents-as-tools
  pnpm examples:deterministic
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

## Style, Linting & Type Checking

- Follow ESLint rules (`eslint.config.mjs`), no unused imports, adhere to Prettier.
- Run `pnpm lint` and fix all errors locally.
- Use `pnpm build` to catch type errors.

## Development Workflow

1.  Sync with `main` (or default branch).
2.  Create a feature/fix branch with a descriptive name:
    ```bash
    git checkout -b feat/<short-description>
    ```
3.  Make changes, add/update tests in `packages/<pkg>/test`.
4.  Run all checks:
    ```bash
    pnpm build && pnpm test && pnpm lint
    ```
5.  Commit using Conventional Commits.
6.  Push and open a pull request.

## Pull Request & Commit Guidelines

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
  - `TYP`: type-related changes
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

## Review Process & What Reviewers Look For

- ✅ All automated checks pass (build, tests, lint).
- ✅ Tests cover new behavior and edge cases.
- ✅ Code is readable and maintainable.
- ✅ Public APIs have doc comments.
- ✅ Examples updated if behavior changes.
- ✅ Documentation (in `docs/`) updated for user-facing changes.
- ✅ Commit history is clean and follows Conventional Commits.

## Tips for Navigating the Repo

- Use `pnpm -F <pkg>` to operate on a specific package.
- Study `vitest.config.ts` for test patterns (e.g., setup files, aliasing).
- Explore `scripts/embedMeta.ts` for metadata generation logic.
- Examples in `examples/` are fully functional apps—run them to understand usage.
- Docs in `docs/src/` use Astro and Starlight; pages mirror package APIs under `docs/src/openai/agents`.
