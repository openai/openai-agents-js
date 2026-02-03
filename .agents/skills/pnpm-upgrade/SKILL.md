---
name: pnpm-upgrade
description: 'Keep pnpm current: run pnpm self-update/corepack prepare, align packageManager in package.json, and bump pnpm/action-setup + pinned pnpm versions in .github/workflows to the latest release. Use this when refreshing the pnpm toolchain manually or in automation.'
---

# pnpm Upgrade

Use these steps to update pnpm and CI pins without blunt search/replace.

## Steps (run from repo root)

1. Update pnpm locally
   - Try `pnpm self-update`; if pnpm is missing or self-update fails, run `corepack prepare pnpm@latest --activate`.
   - Capture the resulting version as `PNPM_VERSION=$(pnpm -v)`.

2. Align package.json
   - Open `package.json` and set `packageManager` to `pnpm@${PNPM_VERSION}` (preserve trailing newline and formatting).

3. Find latest pnpm/action-setup tag
   - Query GitHub API: `curl -fsSL https://api.github.com/repos/pnpm/action-setup/releases/latest | jq -r .tag_name`.
   - Use `GITHUB_TOKEN`/`GH_TOKEN` if available for higher rate limits.
   - Store as `ACTION_TAG` (e.g., `v4.2.0`). Abort if missing.

4. Update workflows carefully (no broad regex)
   - Files: everything under `.github/workflows/` that uses `pnpm/action-setup`.
   - For each file, edit by hand:
     - Set `uses: pnpm/action-setup@${ACTION_TAG}`.
     - If a `with: version:` field exists, set it to `${PNPM_VERSION}` (keep quoting style/indent).
   - Do not touch unrelated steps. Avoid multiline sed/perl one-liners.

5. Verify
   - Run `pnpm -v` and confirm it matches `packageManager`.
   - `git diff` to ensure only intended workflow/package.json changes.

6. Follow-up
   - If runtime code/build/test config was changed (not typical here), run `$code-change-verification`; otherwise, a light check is enough.
   - Commit with `chore: upgrade pnpm toolchain` and open a PR (automation may do this).

## Notes

- Tools needed: `curl`, `jq`, `node`, `pnpm`/`corepack`. Install if missing.
- Keep edits minimal and readable—prefer explicit file edits over global replacements.
- If GitHub API is rate-limited, retry with a token or bail out rather than guessing the tag.
