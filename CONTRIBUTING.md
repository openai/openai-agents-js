# Contributing to OpenAI Agents SDK

## Contribution policy

We welcome bug reports, feature requests, minimal reproductions, and root-cause analysis through [GitHub issues](https://github.com/openai/openai-agents-js/issues).

**Pull requests are limited to repository collaborators. We do not accept pull requests from non-collaborators**, including documentation or example changes. If you are not a collaborator, please open an issue instead of preparing a pull request. Include the affected version, expected and actual behavior, and a small, sanitized reproduction when applicable.

Report suspected security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), rather than in issues or pull requests.

The development and pull request instructions below are for maintainers and repository collaborators.

## Repository structure

This repository is a pnpm-managed monorepo that contains several packages:

- `packages/agents-core`: Core abstractions and runtime for building agent workflows.
- `packages/agents-openai`: OpenAI SDK bindings and concrete implementations.
- `packages/agents`: Convenience bundle that re-exports core and OpenAI packages.
- `packages/agents-realtime`: Realtime bindings and implementations.
- `packages/agents-extensions`: Extensions for additional workflows.

The repository also contains these directories:

- `docs/`: Documentation site (Astro).
- `examples/`: Example projects that show basic usage.
- `scripts/`: Automation scripts, such as the metadata script.
- `helpers/`: Shared utilities for tests and examples.

## Getting started

### Prerequisites

- Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later
- The pnpm version pinned in the root `package.json` `packageManager` field

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

To run the example app or docs site, use these commands:

- `pnpm examples:basic` to start the basic example
- `pnpm docs:dev` to serve the documentation locally

## Development workflow

### Building

To build the packages, run:

```bash
pnpm build
```

The build compiles each package's TypeScript into its `dist/` directory.

### Testing

Run the full test suite with:

```bash
pnpm test
```

Tests use Vitest. Each package keeps its tests under `packages/*/test`.

For provider-neutral agent workflow tests, prefer `ScriptedModel` from the Core testing utilities over a new mock or fake `Model`. Use `ScriptedRealtimeTransport` for Realtime session tests and `scriptedSandboxSession()` for deterministic Sandbox session calls. Keep a specialized test double only for behavior that the scripted utilities cannot preserve. This includes provider-wire conversion, malformed streams, controlled suspension or concurrency, and exact abort or lifecycle boundaries. Document the required behavior in the test.

`pnpm test:review` omits the slow subsystem-specific tests listed in `helpers/vitest/reviewTestProfile.ts`. Those tests remain mandatory in final `pnpm test` verification. The review suite replaces neither focused checks during implementation review nor the final suite.

During iterative implementation review, run focused tests for the changed behavior and relevant subsystem boundaries with `pnpm exec vitest run <path>`, including applicable review-optional cases. Resolve uncertain coverage by tracing affected callers and dependencies and selecting the needed focused checks. Follow [implementation-final-review](.agents/skills/implementation-final-review/SKILL.md) for review sequencing; defer broad tests, builds, and repository-wide type checking until clean review. Then follow [code-change-verification](.agents/skills/code-change-verification/SKILL.md) for the complete final SDK stack. Explicit requests to run a suite outside implementation review remain supported.

### Native preview builds

The **Alpha release artifacts** workflow creates preview packages for Linux, macOS, and Windows on repository pushes and fork PRs targeting `feat/codex-harness`. Same-repository PRs use their push run, avoiding duplicate native builds. It first prepares and publishes a verified native-only snapshot for every platform. All three native jobs must finish before any SDK job starts pnpm, installs dependencies, or builds TypeScript. SDK jobs download the exact artifact IDs and digests captured by those native jobs, then package the current checkout and run the existing extracted-package checks.

A native job may reuse a qualified snapshot from an ancestor push. Canonical `main` and `feat/codex-harness` consumers accept only canonical donors. Other branch snapshots must capture one exact open PR, its repository IDs, and its source branch before SDK execution; later reuse requires the same captured PR scope. Pre-PR or ambiguous snapshots cannot gain that scope later. PR-event runs never donate. Reuse requires the complete caller and both reusable workflows to come from the immutable producer push SHA, independently compatible committed producer inputs, matching platform and native input identities, and validated product hashes and executable modes. Only documentation, examples, and SDK source/test changes qualify without rebuilding; unknown changes build fresh. Repository Cargo configuration is unsupported. Rust sources, revisions, patches, producer helpers, and the native loader must remain unchanged. A missing pinned source uses the existing shallow Git fetch with visible progress, a 5 minute deadline, and a 120 second low-speed limit. A fetch failure stops the job; it never skips the source audit.

The workflow verifies that original native publication finished before the earliest SDK execution across every attempt of a run. Replaced artifact IDs, changed digests, ambiguous timing, and incomplete required history fail visibly. Missing, expired, or incompatible donors trigger compilation. Native producers never restore or save Actions caches, including Cargo dependencies and targets, V8 assets, or prepared source trees. Only completed native-product snapshots that pass these checks cross runs. SDK jobs may retain their own dependency caches. Native snapshots and the fully qualified SDK bundles remain separate artifacts.

### Repository skill tests

Run `pnpm test:repo-skills` to check executable repository skill helpers independently of the SDK test suite. This offline command requires Node.js 22+, Python 3.10+, Git, and installed development dependencies; it does not require a package build. It runs the four Python handoff/review suites, the Node logging inventory suite, runner regression tests, and three changeset result-validator fixtures. A failed suite stops the command with a nonzero exit status.

The runner isolates temporary files and Git configuration, passes only required environment variables to children, and limits Git fixture transports to local files. The changeset shell's prompt-generation check and all four milestone cases are excluded. The runner never invokes `run-fixtures.sh` or milestone assignment. `.github/workflows/repo-skills.yml` runs this command when its owning scripts, skills, or dependency manifests change.

### Code style

- Maintain existing TypeScript style.
- Ensure that `pnpm build` completes without errors.
- Run `pnpm lint` to check formatting and unused imports.

## Changesets and versioning

This repository uses [Changesets](https://github.com/changesets/changesets) for version management and changelog generation. If your changes include non-release-generated updates under `packages/`, create a changeset. This includes internal fixes and tests, not only public API or user-visible changes. Automated release updates limited to package versions, changelogs, and generated `src/metadata.ts` files are exempt.

```bash
pnpm changeset
```

Follow the interactive prompts. Do not manually bump package versions.

## Reporting issues

For a suspected security vulnerability, follow [SECURITY.md](SECURITY.md) and report privately. Do not open a public issue or pull request for an undisclosed vulnerability.

Before opening a new issue, search existing issues to avoid duplicates. When opening an issue, include:

- A clear and descriptive title
- A short summary of the problem or feature request
- Steps to reproduce (for bugs)
- A minimal code snippet or example (if applicable)
- Expected and actual behavior

Use synthetic examples and sanitize attachments before posting. The security guidance below applies to issue reports as well as code contributions.

## Security

### Credentials, examples, and diagnostics

- Never commit real API keys, tokens, authorization headers, cookies, signed URLs, or customer data. Keep local credentials outside version control and use the repository's documented environment-variable setup for authorized live tests.
- Use synthetic fixtures and examples. Inspect logs, snapshots, traces, errors, tool arguments and results, audio, and serialized session or run state for sensitive data before committing or sharing them. Redact secrets and personal information even in private reports.
- Keep standard API keys and other long-lived credentials on the server, outside browser bundles. Browser integrations that connect directly must use the supported short-lived client credential flow.
- Preserve tracing and logging privacy controls. When a change affects sensitive data, test the relevant success and failure paths with synthetic values, including streaming or resumed execution when applicable.
- Review the complete diff and run secret scanning before submitting. If a secret is exposed, stop sharing it, arrange prompt revocation or rotation, and notify maintainers through [SECURITY.md](SECURITY.md#reporting-a-vulnerability). Deleting a file or comment does not revoke the credential.

### Dependencies and security-sensitive changes

Explain why each new dependency is needed. Review package provenance, maintenance, transitive dependencies, and install scripts, and inspect lockfile changes alongside manifests. Preserve any configured release-age cooldown for ordinary dependency updates while allowing security updates without that delay. Triage alerts by affected version, reachability, and impact across runtime, development, and example usage; do not dismiss development dependencies automatically.

Request explicit maintainer security review when changing authentication, credentials or headers, endpoints or redirects, uploads, deserialization, tool approvals, MCP execution, sandbox paths or mounts, persistence, logging, tracing, dependencies, CI, or publishing. Describe the affected trust boundary and provide focused tests for the relevant security property. Handle evidence of an undisclosed vulnerability privately rather than including it in a public PR.

Do not bypass security checks or dismiss alerts solely to unblock a merge. Escalate critical or actively exploited findings promptly through the private reporting route. Any accepted exception needs a responsible owner, rationale, mitigation, approval, and expiry; a scan completion or passing build does not resolve an outstanding finding.

### CI and package publication

Treat external pull request code and metadata as untrusted. Keep secrets and write-capable tokens away from untrusted execution, avoid privileged workflows that run untrusted checkout content, and do not interpolate untrusted metadata into shell commands. Use explicit least-privilege workflow permissions and full commit SHA pins for third-party actions. Preserve required review and security checks, secret scanning and push protection, code scanning, and contributor approval controls.

Release workflows and publishing configuration require code-owner coverage and required code-owner review before release PRs merge. The shared release policy does not require a separate environment-reviewer approval gate. Preserve branch and tag deployment restrictions, trusted-publisher bindings, OIDC publishing, and provenance; do not replace trusted publishing with a long-lived registry token. Workflow configuration alone does not verify a registry binding or published artifact provenance. Maintainers must verify those controls and registry access and recovery arrangements separately, and track missing or unverified controls explicitly.

## Submitting a pull request

These steps are for repository collaborators.

1. Fork the repository and create a branch with a descriptive name (e.g., `fix/missing-error`, `feat/new-tool`).
2. Ensure your branch is up to date with `main`.
3. Make your changes, add or update tests, and ensure that the following succeeds:
   ```bash
   pnpm build && pnpm -r build-check && pnpm test && pnpm lint
   ```
4. If you changed files under `packages/`, generate a changeset (`pnpm changeset`).
5. Make sure you have [Trufflehog](https://github.com/trufflesecurity/trufflehog) installed to ensure no secrets are accidentally committed.
6. Commit your changes using Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
7. Push your branch to your fork and open a pull request against the `main` branch.
8. In the pull request description, link any related issues and summarize your changes.

### Review process

- All pull requests require at least one approving review from a maintainer.
- Automated checks (build, test, docs) must pass before merging.
- We use squash merging; each pull request results in a single commit on `main`.

## Releasing

CI runs after every push to `main`. When CI passes, the Changeset Action checks for open changeset entries. It adds them to an existing version bump PR or creates a new one.

To release a new version, a maintainer merges the PR from Changeset.

## License and code of conduct

By contributing, you agree to license your contributions under the project's MIT license.

## Questions

For help, open an [issue](https://github.com/openai/openai-agents-js/issues).
