# Contributing to OpenAI Agents SDK

Thank you for your interest in contributing to the OpenAI Agents SDK. This document outlines the process for reporting issues, proposing changes, and submitting pull requests.

## Repository structure

This repository is a pnpm-managed monorepo that contains several packages:

- `packages/agents-core`: Core abstractions and runtime for building agent workflows.
- `packages/agents-openai`: OpenAI SDK bindings and concrete implementations.
- `packages/agents`: Convenience bundle that re-exports core and OpenAI packages.
- `packages/agents-realtime`: Realtime bindings and implementations.
- `packages/agents-extensions`: Extensions for additional workflows.

Other important directories:

- `docs/`: Documentation site (Astro).
- `examples/`: Example projects demonstrating basic usage.
- `scripts/`: Automation scripts (e.g. embedding metadata).
- `helpers/`: Shared utilities used across tests and examples.

## Getting started

### Prerequisites

- Node.js 22 or later
- pnpm 10 or later

### Setup

```bash
# Clone the repository
git clone https://github.com/openai/openai-agents-js.git
cd openai-agents-js

# Install dependencies
pnpm install

# Build all packages
pnpm build
# Check that all packages compile
pnpm -r build-check

# Run tests
pnpm test
```

Optionally, you can run the example app or docs site:

- `pnpm examples:basic` to start the basic example
- `pnpm docs:dev` to serve the documentation locally

## Development workflow

### Building

After making code changes, run:

```bash
pnpm build
```

This compiles TypeScript into `dist/` directories for each package.

### Testing

Run the full test suite with:

```bash
CI=1 pnpm test
```

Tests use Vitest and are located alongside source files in each package under `packages/*/test`.

### Code style

- Maintain existing TypeScript style.
- Ensure that `pnpm build` completes without errors.
- Run `pnpm lint` to check formatting and unused imports.

## Changesets and versioning

This repository uses [Changesets](https://github.com/changesets/changesets) for version management and changelog generation.
If your changes affect the public API or introduce user-visible changes (bug fixes, new features, or breaking changes), create a changeset:

```bash
pnpm changeset
```

Follow the interactive prompts. Do not manually bump package versions.

## Reporting issues

Before opening a new issue, search existing issues to avoid duplicates.
When opening an issue, include:

- A clear and descriptive title
- A short summary of the problem or feature request
- Steps to reproduce (for bugs)
- A minimal code snippet or example (if applicable)
- Expected and actual behavior

## Submitting a pull request

1. Fork the repository and create a branch with a descriptive name (e.g., `fix/missing-error`, `feat/new-tool`).
2. Ensure your branch is up to date with `main`.
3. Make your changes, add or update tests, and ensure that the following succeeds:
   ```bash
   pnpm build && pnpm -r build-check && pnpm test && pnpm lint
   ```
4. If applicable, generate a changeset (`pnpm changeset`).
5. Make sure you have [Trufflehog](https://github.com/trufflesecurity/trufflehog) installed to ensure no secrets are accidentally committed.
6. Commit your changes using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
7. Push your branch to your fork and open a pull request against the `main` branch.
8. In the pull request description, link any related issues and summarize your changes.

### Review process

- All pull requests require at least one approving review from a maintainer.
- Automated checks (build, test, docs) must pass before merging.
- We use squash merging; each pull request results in a single commit on `main`.

## Releasing

Releasing happens automatically. After every push to `main` the CI will run. After it passed,
the Changeset Action will check if there are any open changeset entries and add them to either an
open version bump PR or create a new one.

For a maintainer to release a new version, the PR from Changeset has to be merged.

## License and code of conduct

By contributing, you agree that your contributions will be licensed under the project’s MIT license.

## Questions

If you have any questions or need guidance, feel free to open an issue or ask in a pull request. Maintainers are happy to help.
