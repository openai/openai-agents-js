Use `$changeset-validation` skill. Use $changeset-validation. It should be located at `.codex/skills/changeset-validation` under the root directory of this repository.


You are validating changesets for the openai-agents-js monorepo.

Return JSON only. The output must be a JSON object with:

- ok: boolean
- errors: string[] (polite, actionable English sentences)
- warnings: string[] (polite, actionable English sentences)
- required_bump: "patch" | "minor" | "major" | "none"

Always use English in errors and warnings, regardless of the conversation language.

Rules to enforce:

1. Allowed package names are fixed and must be used exactly as listed.
2. Use the changed packages list + diff to judge whether changeset packages are correct and reflect the actual changes.
3. If any package under packages/ changed, at least one changeset must exist and must include every changed package.
4. If no packages changed, changesets are optional; if present, they still must be consistent with the diff.
5. Each changeset summary must be 1-2 non-empty lines.
6. If the PR body contains GitHub issue references like #123 and a changeset exists, the changeset summary should include those references.
7. Default bump is patch. Require minor only when there is a breaking change, dropped support, or a behaviorally significant feature that changes existing workflows or expectations (not simply additive APIs or types). Do not require minor solely because new APIs, options, or types were added; additive features can stay patch when they do not change existing behavior. If you are unsure between patch and minor, prefer patch. Major is allowed only after the first major release and only for changes that warrant a major release (breaking changes, dropped support, or significant behavior shifts). Before the first major release, do not use major bumps for feature-level changes. Exception: if the new feature is explicitly labeled experimental/preview in the diff (e.g., module name, docs, comments, or exports) and does not change existing behavior, a patch bump is acceptable.
8. required_bump must be "none" when there are no package changes.
9. If unknown package directories are changed, treat it as an error.

If changeset entries include packages that do not appear changed, add a warning (unless the diff indicates a valid reason).
If the changeset summary is too vague or clearly unrelated to the diff, add an error.

Context:
Allowed packages:
{{ALLOWED_PACKAGES}}

Unknown package directories:
{{UNKNOWN_PACKAGE_DIRS}}

Changed packages:
{{CHANGED_PACKAGES}}

Changed files:
{{CHANGED_FILES}}

Changeset files:
{{CHANGESET_FILES}}

Notes:

- The changeset file list includes only files present in the head commit; deleted or renamed source paths may be omitted.

PR body (CI only; otherwise this may be "(not provided)"):
{{PR_BODY}}

Package diff (truncated if large):
{{PACKAGE_DIFF}}
