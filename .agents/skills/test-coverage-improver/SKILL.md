---
name: test-coverage-improver
description: 'Improve test coverage in the OpenAI Agents JS monorepo: run `pnpm test:coverage`, inspect coverage artifacts, identify low-coverage files and branches, propose high-impact tests, and confirm with the user before writing tests.'
---

# Test Coverage Improver

## Overview

Use this skill whenever coverage needs assessment or improvement (coverage regressions, failing thresholds, or user requests for stronger tests). It runs the coverage suite, analyzes results, highlights the biggest gaps, and prepares test additions while confirming with the user before changing code.

## Quick Start

1. From the repo root run `pnpm test:coverage` (set `CI=1` if needed) to regenerate `coverage/`.
2. Collect artifacts: `coverage/coverage-summary.json` (preferred) or `coverage/coverage-final.json`, plus `coverage/lcov.info` and `coverage/lcov-report/index.html` for drill-downs.
3. Summarize coverage: total percentages, lowest files, branches under 80%, and uncovered lines/paths.
4. Draft test ideas per file: scenario, behavior under test, expected outcome, and likely coverage gain.
5. Ask the user for approval to implement the proposed tests; pause until they agree.
6. After approval, write the tests in the relevant package, rerun `pnpm test:coverage`, and then run `$code-change-verification` before marking work complete.

## Workflow Details

- **Run coverage**: Execute `CI=1 pnpm test:coverage` at repo root. Avoid watch flags and keep prior coverage artifacts only if comparing trends.
- **Parse summaries efficiently**:
  - Prefer `coverage/coverage-summary.json` for file-level totals; fallback to `coverage/coverage-final.json` if the summary file is absent.
  - Use `coverage/lcov.info` or `coverage/lcov-report/index.html` to spot branch- and line-level holes.
- **Prioritize targets**:
  - Public APIs or shared utilities in `packages/*/src` before examples or docs.
  - Files with statements/branches below 80% or newly added code at 0%.
  - Recent bug fixes or risky code paths (error handling, retries, timeouts, concurrency).
- **Design impactful tests**:
  - Hit uncovered branches: error cases, boundary inputs, optional flags, and cancellation/timeouts.
  - Cover combinational logic rather than trivial happy paths.
  - Place unit tests near the package (`packages/<pkg>/test/*.test.ts`) and avoid flaky async timing.
- **Coordinate with the user**: Present a numbered, concise list of proposed test additions and expected coverage gains. Ask explicitly before editing code or fixtures.
- **After implementation**: Rerun coverage, report the updated summary, and note any remaining low-coverage areas.

## Notes

- Keep any added comments or code in English.
- Do not create `scripts/`, `references/`, or `assets/` unless needed later.
- If coverage artifacts are missing or stale, rerun `pnpm test:coverage` instead of guessing.
