You are running in CI for the scheduled pnpm toolchain refresh.

Follow the `$pnpm-upgrade` skill instructions from the repo root. Key points:

- Update pnpm via `pnpm self-update` (or `corepack prepare pnpm@latest --activate`), record PNPM_VERSION.
- Update `package.json` packageManager to match.
- Fetch the latest `pnpm/action-setup` tag via GitHub API; use it when editing workflows.
- Manually edit each workflow that uses pnpm/action-setup to set the tag and pnpm version (no blanket regex replacements).
- Do not commit or push; leave changes unstaged. Keep output brief; tests are not required.
