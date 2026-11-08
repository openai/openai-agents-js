# Migrate an order-support application

This example ports one application from `@openai/agents@0.21.0` to native v1. It also shows the optional classic step. The application looks up a customer's order, records one permitted notification, and denies a second notification after the application revokes permission. The scripts record notifications in memory and never contact a messaging service.

The three implementations share only [business data and permission checks](business.ts). Compare [v0](v0/app.mts), [classic](classic.ts), and [native](native.ts). Native changes the Agent, tool callback context, structured-output declaration, execution, and state together. Classic retains Runner and MemorySession. No helper chooses a runtime or converts state.

## Use matching packages and examples

Use Node.js 24. Start with a clean, committed checkout containing this directory and record `git rev-parse HEAD`. Follow [Build from source](../guides/building.md#build-from-source) in that same checkout, including `pnpm native:prepare`, `pnpm native:build`, and `pnpm build`. Run the commands below from its root. The example and SDK then use the same source commit.

For an application outside the checkout, follow the [five-package local bundle procedure](../guides/building.md#build-a-local-bundle-for-an-application) from that same committed source. Copy this example alongside its matching bundle. Keep the build record, five tarballs, generated dependencies and overrides, and lockfile together. The bundle producer rejects uncommitted source changes; commit an example change before producing its application bundle.

The downloadable `0.22.0-alpha.1` preview starter uses an earlier four-package layout and API. Its own included example and [preview installation instructions](../guides/installation.md#run-the-starter-bundle) belong together. A preview version label alone does not identify a source commit; read the build record. Do not install that starter and run this current-source example against it.

## Check the application's contracts

| Requirement | Classic | Native |
| --- | --- | --- |
| Typed application context | `RunContext<SupportContext>` | `ToolContext<SupportContext>` |
| Customer ownership | Business lookup checks customer and order | Same business check |
| Allowed notification | Business function records a receipt | Same business function |
| Denied notification | Callback rejects before the effect | `before` denies; business check also protects execution |
| Structured answer | Agent `outputType` | Native output schema |
| Two user turns | Runner with one MemorySession | Submissions to one Session |
| Existing v0 state | Same Agent/tool declarations on classic | Reviewed business facts start fresh history |
| Native restart | Not a classic checkpoint | Save native state, close, parse, reopen |

[runClassicExample](classic.ts) and [runNativeExample](native.ts) contain the complete two-turn workflows. Both return typed order answers. The native workflow also closes and reopens its checkpoint with current trusted declarations and context. Checkpoint restoration does not replay a settled notification. It does not establish exactly-once delivery or resolve an uncertain remote effect; a real notification service must supply that receipt and reconciliation.

The application chooses `order-support` or `refund-review` through `routeSupport`. Store that choice with the application's conversation record and use it for the next user turn. The refund route has no order notification tools. This is application-owned routing, not an SDK handoff. A specialist called through `Agent.asTool()` would return a result to its caller; that result alone would not transfer next-turn ownership. Port a true classic handoff only after deciding who owns the next turn and its history.

## Run the released v0 application separately

The [v0 application](v0/README.md) must resolve `@openai/agents@0.21.0`, not this checkout's native root import. Copy it outside the workspace, install its own dependencies, and save a real v0 record:

```sh
V0_DIRECTORY=$(mktemp -d)
mkdir "$V0_DIRECTORY/v0"
cp examples/codex/migration/business.ts "$V0_DIRECTORY/business.ts"
cp examples/codex/migration/v0/package.json examples/codex/migration/v0/app.mts "$V0_DIRECTORY/v0/"
(cd "$V0_DIRECTORY/v0" && npm install --ignore-scripts && npm test -- "$V0_DIRECTORY/records")
```

The public v0 ScriptedModel supplies synthetic model responses. The real released Runner executes the tools, checks their effects, checks that the recall request contains prior tool facts, and writes `classic-state.json`. Retain its generated lockfile. No model key is needed.

## Run the current classic and native checks

The [classic](classic.ts) and [native](native.ts) files export application functions. The test suite below runs them with scripted responses, so no model key is needed. After the matching source build, return to the repository root:

```sh
MIGRATION_V0_RECORD="$V0_DIRECTORY/records/classic-state.json" OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/native/migration-example.test.ts
```

The suite runs the classic and native examples through their public SDK imports and existing scripted model providers. It checks structured values, lookup arguments, the permitted effect, the denied effect's absence, prior facts in the second request, and prior facts after native checkpoint restore. It also feeds the current classic result into a fresh native conversation and verifies that no old tool-call identity enters that request.

With `MIGRATION_V0_RECORD`, the suite also reads the actual v0-produced state and history and continues them on classic with the same declarations. It then supplies the saved v0 business facts directly to native, and the continued classic result to a separate native conversation. `startNativeFromReviewedFacts` validates the selected output fields and excludes state and tool receipts. The application must approve the facts; schema validation does not prove their truth. Without that variable, those historical state checks skip. The ordinary native CI suite exercises the current classic/native workflows without downloading another SDK. Scripted tests establish application behavior under prescribed model output; they do not measure live model tool choice or answer quality.

For a direct port, finish existing v0 conversations on their original deployment and supply the approved v0 output to [startNativeFromReviewedFacts](native.ts) where needed. For a staged port, first validate [continueClassic](classic.ts), finish classic conversations there, and then use the same fresh-input native boundary. Keep each runtime's state in its own store. A rollback routes new work to the tested prior runtime and leaves existing native checkpoints with a compatible native worker.
