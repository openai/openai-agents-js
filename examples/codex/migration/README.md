# Migrate one order lookup

Follow the [migration guide](../guides/migration.md). Compare one small application in [released v0](v0/app.mts), optional [classic](classic.ts), and [native v1](native.ts). Each declares one Agent, one read-only tool, typed customer context, and typed output.

Use Node.js 24 and a [matching source build](../guides/building.md#build-from-source), with the [installation requirements](../guides/installation.md#requirements). Run these commands from the repository root. The older `0.22.0-alpha.1` starter has a different API and package layout.

## Check without a model key

Copy the v0 app outside the workspace so its root import resolves the pinned `@openai/agents@0.21.0` package. Its test runs the lookup and saves real RunState, MemorySession history, and selected output fields:

```sh
V0_DIRECTORY=$(mktemp -d)
cp examples/codex/migration/v0/* "$V0_DIRECTORY/"
(cd "$V0_DIRECTORY" && npm install --ignore-scripts && MIGRATION_V0_RECORD="$V0_DIRECTORY/classic-state.json" npm test)
MIGRATION_V0_RECORD="$V0_DIRECTORY/classic-state.json" OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/native/migration-example.test.ts
```

Keep the generated lockfile. The Vitest command runs the optional classic port as well as native. It checks customer-scoped tool results, typed output, and native checkpoint restore. The historical-state check hydrates classic state without replaying completed callbacks, then continues its history with updated facts. Both direct and staged cutovers start fresh native conversations. The staged cutover uses the updated classic result; old call IDs and execution state stay behind.

Without `MIGRATION_V0_RECORD`, the historical-state check skips; current classic and native checks still run. Scripted responses establish behavior for prescribed model output, rather than live model tool choice or answer quality.

For optional application features, use the existing [effects](../concurrency-effects/README.md), [specialist](../input-retrieval-specialist/README.md#run-the-standalone-specialist), and [state](../guides/state.md) guides.
