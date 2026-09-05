---
name: docs-sync
description: Audit or update authored English SDK documentation within a requested topic or diff using implementation evidence.
---

# Docs Sync

## Overview

Identify documentation gaps and inaccuracies within the requested topic or diff using implementation evidence.

## Scope and authorization

For audit or proposal-only requests, report findings without editing. When the user requests updates or has approved a plan, complete the scoped edits and verification without asking again. Ask only for unresolved behavior, scope, release timing, or additional authority. Apply the repository's Documentation Release Timing policy before including unreleased behavior in `docs/`.

## Workflow

1. Confirm scope and base branch
   - Identify the current branch and default branch (usually `main`).
   - Prefer analyzing the current branch to keep work aligned with in-flight changes.
   - Use a branch diff only for a branch-scoped request. A requested topic or released-doc correction remains in scope even when unrelated to the current branch diff.
   - Avoid switching branches if it would disrupt local changes. Prefer read-only inspection such as `git show main:<path>`. If a separate checkout is genuinely required, stop and obtain the explicit approval required by `AGENTS.md` before creating or switching a worktree.

2. Build a feature inventory from the selected scope
   - Bound the inventory to the requested topic or diff. Inventory the full surface only for an explicitly comprehensive audit.
   - For branch-scoped work, inspect additions, changes, and removals relative to the intended base.
   - Focus on user-facing behavior: public exports, configuration options, environment variables, CLI commands, default values, and documented runtime behaviors.
   - Capture evidence for each item (file path + symbol/setting).
   - Use targeted search to find option types and feature flags (for example: `rg "Options"`, `rg "process.env"`, `rg "export"`).
   - When the topic involves OpenAI platform features, invoke `$openai-knowledge` to pull current details from the OpenAI Developer Docs MCP server instead of guessing, while treating the SDK source code as the source of truth when discrepancies appear.
   - For MCP SDK (`modelcontextprotocol/typescript-sdk`) or Vercel AI SDK (`@ai-sdk/*`) topics, optionally use Deepwiki MCP for quick lookups, and still treat the SDK source code as the source of truth.

3. Doc-first pass: review existing pages
   - Walk each relevant page under `docs/src/content/docs` (excluding `docs/src/content/docs/openai`).
   - Identify missing mentions of important, supported options (opt-in flags, env vars), customization points, or new features from `packages/`.
   - Propose additions where users would reasonably expect to find them on that page.

4. Code-first pass: map features to docs
   - Review the current docs information architecture under `docs/src/content/docs`.
   - Determine the best page/section for each feature based on existing patterns and package boundaries.
   - Identify features that lack any doc page or have a page but no corresponding content.
   - Note when a structural adjustment would improve discoverability.

5. Detect gaps and inaccuracies
   - **Missing**: features/configs present in main but absent in docs.
   - **Incorrect/outdated**: names, defaults, or behaviors that diverge from main.
   - **Structural issues** (optional): pages overloaded, missing overviews, or mis-grouped topics.

6. Classify the proposed complete diff
   - Use the Documentation Change Verification Tiers in `AGENTS.md` as the single source of truth.
   - Classify the complete proposed diff by its highest applicable Editorial, Content, or Structural tier before editing.
   - Keep the tier-specific verification separate from the existing eligibility rules for `$implementation-final-review`, `$code-change-verification`, `$changeset-validation`, and `$pr-draft-summary`.

7. Report findings or continue authorized updates
   - For audit-only work, provide evidence, suggested locations, proposed edits, and required verification, then stop.
   - For an update request, complete the authorized edits using the findings and selected verification tier.

8. Apply authorized changes (English only)
   - Edit only English docs in `docs/src/content/docs/**`.
   - Exclude `docs/src/content/docs/openai` from review and updates.
   - Do **not** edit `docs/src/content/docs/ja`, `docs/src/content/docs/ko`, or `docs/src/content/docs/zh`.
   - Keep changes aligned with the existing docs style and navigation.
   - Do not add TypeScript or TSX fenced blocks directly to MDX. Place every TypeScript or TSX snippet in a compilable source file under `examples/docs/<doc-area>/`, import it into MDX with `?raw`, and render that imported source using the existing docs pattern.
   - If code is not useful enough to maintain as a complete example, explain the behavior in prose instead of adding an unverified snippet.
   - Run the focused verification required by the highest applicable Documentation Change Verification Tier in `AGENTS.md`. When the complete diff changes a rendered TypeScript or TSX snippet source or its MDX import/rendering, run `pnpm -F docs-code build-check` and fix issues before handoff.

## Output format

Use this template when reporting findings:

Docs Sync Report

- Doc-first findings
  - Page + missing content → evidence + suggested insertion point
- Code-first gaps
  - Feature + evidence → suggested doc page/section (or missing page)
- Incorrect or outdated docs
  - Doc file + issue + correct info + evidence
- Structural suggestions (optional)
  - Proposed change + rationale
- Proposed edits
  - Doc file → concise change summary
- Unresolved decisions, only when needed

## References

- `references/doc-coverage-checklist.md`
