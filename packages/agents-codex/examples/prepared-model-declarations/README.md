# Prepare a model request without changing tool authority

A custom classic `Model` receives the instructions, history and serialized tool declarations that the Runner admitted for the next sampling call. Use the custom Model to prepare what the model sees. Keep the original tool objects registered on the Agent.

[index.ts](index.ts) wraps an offline `ScriptedModel` with `withPreparedRequest`. It copies only `systemInstructions`, `input` and `tools` with `structuredClone`, then edits the copy before delegating. The signal, model settings and other request fields retain their existing handling. Clone the nested data because a serialized function declaration can still share its parameter schema with the registered tool.

The example changes instructions, appends a model-facing history note and edits the admitted booking declaration. The Runner omits the disabled erase tool. The scripted model requests two seats, the run pauses for approval, and approving the interruption lets the original booking handler execute once. This example supplies an approval decision in code; a real application should obtain the user's decision first.

From a built source checkout, run:

```sh
pnpm exec tsx packages/agents-codex/examples/prepared-model-declarations/index.ts
```

This needs workspace dependencies and the built classic packages, but no API key, external model service or native addon. The command uses the ordinary response-mode classic Runner. The wrapper also delegates the required Model streaming method, but this example does not qualify streaming behavior.

## What an edit can change

You can prepare the sampled instructions, edit text or add context in the copied history, and change descriptions or JSON schemas in the copied admitted declarations. Keep tool names and namespaces aligned with the registered tools when you want the model to request them. These model-facing edits do not update the Agent's instructions, caller-owned history or registered tool objects.

A declaration is not an execution grant. Removing an admitted declaration from the copied request changes what the model sees. It does not change the registered handler's authority. Disable disallowed tools through the Agent's existing `isEnabled` policy, as this example does.

The example deliberately raises the sampled seat limit from three to 99. The original validator still rejects a request for nine seats, even after approval. An accepted request for two seats still needs the original approval policy. Rejecting it prevents execution. A request for a disabled or invented function does not execute a handler; the Runner can report that refusal as a tool error to the model.

The regression exercises these outcomes end to end and checks that nested edits leave the original schema and history intact:

```sh
pnpm exec vitest run --project @openai/agents-codex packages/agents-codex/test/classic/prepared-model-declarations.test.ts
```

This uses the existing [classic Model/Runner route](../../../agents/CLASSIC.md). It does not add a request-editing SDK API or grant control over internal compaction, reviewer or native-only request families.
