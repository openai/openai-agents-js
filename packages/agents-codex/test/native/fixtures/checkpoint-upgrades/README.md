# Checkpoint upgrade captures

Each producer directory contains original `JSON.stringify(await session.saveState())` or `JSON.stringify(await session.suspend())` bytes. The manifest records their hashes, SDK envelope versions, exact producer source snapshot, and matching native artifact identity. These captures are synthetic source snapshots, not stable v1 releases. Do not edit or format their JSON bytes.

The initial producer is `fdd15e8abe181c64d3cbdff25b38f9c571af0a66`, with native artifact `13581513489` and its verified `native/build-receipt.json`. `native_archive_sha256` hashes the downloaded native bundle archive; `native_receipt_sha256` hashes its build receipt. SDK formats 4, 5, and 6 lower to native checkpoint formats 2, 2 plus manual continuation, and 4 respectively. The SDK envelope and native codec versions are distinct.

`checkpoint-upgrades-native.test.ts` verifies capture hashes and runs the idle, manual, output-contract, and CodeMode continuation scenarios through the current native binding. It also checks future-format, foreign-revision, and changed-output rejection. The normal full native suite discovers this file through `test/**/*.test.ts`. Retain old captures when qualifying a newer candidate; a successful same-pin restore requires no data rewrite.

## Reproduce a capture

Use Node 24, the producer checkout's frozen dependencies, and the matching native artifact verified by its maintained native build tooling. Set `PRODUCER` to that immutable checkout, `FIXTURES` to this directory, and `ARTIFACT` to the downloaded bundle archive. Use absolute paths. The external capture test imports the producer's public SDK through its existing Vitest source aliases. Its model peer must match the producer's unchanged fixture.

```sh
cmp "$PRODUCER/packages/agents-codex/test/native/fixtures/model-server.ts" "$FIXTURES/../model-server.ts"
cat > "$PRODUCER/node_modules/.checkpoint-capture.config.mts" <<'CONFIG'
import { resolve } from 'node:path';
import { createWorkspacePackageAliases, readWorkspacePackages } from '../helpers/vitest/workspacePackageAliases';
const source = process.env.CHECKPOINT_PRODUCER_SOURCE;
const aliases = createWorkspacePackageAliases(readWorkspacePackages(resolve(source, 'packages')));
export default {
  root: source,
  resolve: { alias: aliases },
  test: { alias: aliases, include: [process.env.CHECKPOINT_CAPTURE_SCRIPT], pool: 'forks', maxWorkers: 1 },
};
CONFIG
cd "$PRODUCER"
env -u OPENAI_API_KEY \
  OPENAI_AGENTS_NATIVE_TESTS=1 OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX=1 \
  CHECKPOINT_PRODUCER_SOURCE="$PRODUCER" \
  CHECKPOINT_CAPTURE_OUTPUT="$FIXTURES/fdd15e8a" \
  CHECKPOINT_CAPTURE_SCRIPT="$FIXTURES/capture.ts" \
  CHECKPOINT_PRODUCER_ARTIFACT="$ARTIFACT" \
  CHECKPOINT_PRODUCER_ARTIFACT_ID=13581513489 \
  corepack pnpm exec vitest run --config node_modules/.checkpoint-capture.config.mts
```

The script sets a controlled `/tmp/agents-checkpoint-capture` working directory before opening Sessions. The producer rejects the stale manual reply after sealing. Model data, credentials and tool results are synthetic. UUIDs and timestamps vary between fresh captures, so recapture deliberately and review the new bytes and manifest together. Format the capture script before running it; its recorded hash identifies the exact generator used. Keep the source checkout and matching native artifact immutable.

These three scenarios do not represent every historical preview producer. Existing schema regression tests retain coverage for all currently accepted envelopes. No cross-language restore, downgrade, native-pin migration, or stable-release upgrade is established by these snapshots.
