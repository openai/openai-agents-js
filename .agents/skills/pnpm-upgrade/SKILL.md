---
name: pnpm-upgrade
description: 'Keep pnpm current: preflight the published package and pnpm/action-setup self-installer, update pnpm locally, align packageManager in package.json, and refresh CI pins. Use this when refreshing the pnpm toolchain manually or in automation.'
---

# pnpm Upgrade

Use these steps to update pnpm and CI pins without blunt search/replace.

## Steps (run from repo root)

1. Resolve the target pnpm release
   - Query the npm registry before changing the local toolchain: `PNPM_VERSION=$(curl -fsSL https://registry.npmjs.org/pnpm/latest | jq -r .version)`.
   - Abort if the version is missing.
   - Resolve the exact package integrity: `curl -fsSL "https://registry.npmjs.org/pnpm/${PNPM_VERSION}" | jq -r .dist.integrity`.
   - Store the result as `PNPM_INTEGRITY`.
   - Abort if the integrity is missing or does not start with `sha512-`.
   - Convert the base64 digest after `sha512-` to lowercase hex, for example:
     ```bash
     printf '%s' "${PNPM_INTEGRITY#sha512-}" | base64 -d | xxd -p -c 256
     ```
   - Store the result as `PNPM_SHA512_HEX`.

2. Find the target pnpm/action-setup release
   - Query GitHub API: `curl -fsSL https://api.github.com/repos/pnpm/action-setup/releases/latest | jq -r .tag_name`.
   - Use `GITHUB_TOKEN`/`GH_TOKEN` if available for higher rate limits.
   - Store as `ACTION_TAG` (e.g., `v4.2.0`). Abort if missing.

3. Resolve the action tag to an immutable commit SHA
   - Run `git ls-remote https://github.com/pnpm/action-setup "refs/tags/${ACTION_TAG}^{}"` and capture the SHA as `ACTION_SHA`.
   - If the dereferenced tag is missing, fall back to `git ls-remote https://github.com/pnpm/action-setup "refs/tags/${ACTION_TAG}"`.
   - Abort if `ACTION_SHA` is empty.

4. Preflight the release and CI installation path
   - Run `node .agents/skills/pnpm-upgrade/scripts/preflight.mjs --version "${PNPM_VERSION}" --action-ref "${ACTION_SHA}"`.
   - The script first rejects published pnpm manifests with non-empty `dependencies` or `devDependencies`. pnpm bundles its runtime dependencies, so these fields indicate a broken publication such as `pnpm@11.12.0`.
   - It then reproduces both `pnpm/action-setup` installation paths in separate temporary directories: install the regular `pnpm` bootstrap from `pnpm-lock.json` and the standalone `@pnpm/exe` bootstrap from `exe-lock.json`, set isolated `PNPM_HOME` directories, and self-update each bootstrap to `PNPM_VERSION`.
   - Abort the upgrade on any failure. Do not bypass this check with a direct local install; the preflight exists to exercise the CI-only bootstrap path.

5. Update pnpm locally
   - Run `pnpm self-update "${PNPM_VERSION}"`.
   - If pnpm is missing or self-update fails only because the current installation cannot update itself, run `corepack prepare "pnpm@${PNPM_VERSION}" --activate`. Do not use this fallback to bypass a failed preflight.
   - Confirm `pnpm -v` exactly matches `PNPM_VERSION`.

6. Align package.json
   - Open `package.json` and set `packageManager` to `pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512_HEX}` (preserve trailing newline and formatting).

7. Update workflows carefully (no broad regex)
   - Files: everything under `.github/workflows/` that uses `pnpm/action-setup`.
   - For each file, edit by hand:
     - Set `uses: pnpm/action-setup@${ACTION_SHA}`.
     - If a `with: version:` field exists, set it to `${PNPM_VERSION}` (keep quoting style/indent).
   - Do not touch unrelated steps. Avoid multiline sed/perl one-liners.

8. Verify
   - Run `pnpm -v` and confirm it matches the version portion of `packageManager`.
   - Confirm `packageManager` keeps the exact `+sha512.${PNPM_SHA512_HEX}` suffix.
   - `git diff` to ensure only intended workflow/package.json changes.

9. Follow-up
   - If runtime code/build/test config was changed (not typical here), run `$code-change-verification`; otherwise, a light check is enough.
   - Commit with `chore: upgrade pnpm toolchain` and open a PR (automation may do this).

## Notes

- Tools needed: `curl`, `jq`, `base64`, `xxd`, `node`, `npm`, and `pnpm`/`corepack`. Install if missing.
- Keep edits minimal and readable—prefer explicit file edits over global replacements.
- GitHub Actions must stay pinned to commit SHAs, not tags. Use the latest release tag only to discover the commit SHA to pin.
- If GitHub API is rate-limited, retry with a token or bail out rather than guessing the tag.
