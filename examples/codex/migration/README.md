# Migrate one order lookup

Follow the [v0-to-native walkthrough](../guides/migration.md) to port one Agent, one read-only order tool, typed customer context, and typed output. Compare [released v0](v0/app.mts) directly with [native v1](native.ts). The optional [classic step](classic.ts) changes only the SDK import and function name from the released-v0 implementation.

Use Node.js 24, check the [installation requirements](../guides/installation.md#requirements), and prepare a [matching source build](../guides/building.md#build-from-source). Run the commands below from the repository root after building the SDK. The older `0.22.0-alpha.1` starter uses a different package layout and API.

## Check the lookup offline

First run the released-v0 example outside the workspace so its root import resolves the stable `@openai/agents@0.21.0` package:

```sh
V0_DIRECTORY=$(mktemp -d)
cp examples/codex/migration/v0/* "$V0_DIRECTORY/"
(cd "$V0_DIRECTORY" && npm install --ignore-scripts && npm test)
```

Keep the generated lockfile for later checks. This test uses the released SDK's ScriptedModel to request the lookup and return its typed answer. It checks that the tool returns the current customer's order when another customer has an order with the same ID.

Then check the current classic and native implementations:

```sh
OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/native/migration-example.test.ts
```

The suite checks the same customer-scoped lookup and typed output with scripted responses. It also runs the optional advanced example's current-runtime checks; historical state checks skip unless you supply that example's record. Neither command needs a model key. Scripted checks establish behavior for prescribed model output, rather than live tool choice or answer quality.

For a live native call, import `runNativeLookup` into your application, create a `NativeProvider`, and pass the context shown in the walkthrough. Dispose the provider after the function returns. Live calls need model credentials.

The [optional advanced example](advanced/README.md) covers effects, routing, conversation history, released-v0 continuation, and native checkpoints separately.
