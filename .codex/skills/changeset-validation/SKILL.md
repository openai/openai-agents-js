---
name: changeset-validation
description: Validate changesets in openai-agents-js using LLM judgment against git diffs (including uncommitted local changes). Use when packages/ or .changeset/ are modified, or when verifying PR changeset compliance and bump level.
---

# Changeset Validation

## Overview

This skill validates whether changesets correctly reflect package changes and follow the repository rules. It relies on the shared prompt in `references/validation-prompt.md` so local Codex reviews and GitHub Actions share the same logic.
Experimental or preview-only feature additions that are explicitly labeled as such in the diff may remain a patch bump when they do not change existing behavior.
Major bumps are only allowed after the first major release; before that, do not use major bumps for feature-level changes.

## Quick start

Local (Codex-driven):

1. Run:
   ```bash
   pnpm changeset:validate-prompt
   ```
2. Apply the rules from `references/validation-prompt.md` to the generated prompt.
3. Respond with a JSON verdict containing ok/errors/warnings/required_bump (English-only strings).

CI (Codex Action):

1. Run:
   ```bash
   pnpm changeset:validate-prompt -- --ci --output .github/codex/prompts/changeset-validation.generated.md
   ```
2. Use `openai/codex-action` with the generated prompt and JSON schema to get a structured verdict.

## Workflow

1. Generate the prompt context via `pnpm changeset:validate-prompt`.
2. Apply the rules in `references/validation-prompt.md` to judge correctness.
3. Provide a clear verdict and required bump (patch/minor/major/none).
4. If the changeset needs edits, update it and re-run the validation.

## Shared source of truth

- Keep the prompt file as the single source of validation rules.
- Keep the script lightweight: it should only gather context and emit the prompt.

## Resources

- `references/validation-prompt.md`
