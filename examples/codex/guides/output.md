# Output contracts

Use plain text, native structured output, or prompted JSON. Configure a default for an Agent or select a contract for one turn.

## Choose an output mode

Choose how the model produces its final value. `Completed.finalOutput` retains the inferred output type.

| `outputType` | Model request and validation |
| --- | --- |
| Omitted, or bare unconstrained `z.string()` | Plain text. |
| A Zod schema, or `{ mode: 'native', schema }` | Native structured output followed by local schema validation. |
| `{ mode: 'prompted', schema }` | JSON instructions in the prompt followed by local parsing and validation. |

Use native structured output when the provider should enforce a closed schema. Choose prompted JSON when you need an open map or want the model to repair invalid formatting.

### Native structured output

Use `outputType: { mode: 'native', schema: answerSchema }` to select native structured output explicitly. Native object schemas must be closed. Primitive and array outputs use an object with one required `response` field; the SDK unwraps that field before returning the result. Explicit native `z.string()` also uses this wrapper, while bare unconstrained `z.string()` returns plain text.

The SDK removes defaults from the model-visible native schema, closes object schemas and marks every declared property as required. A Zod optional or defaulted property therefore does not let the model omit that field. Use a nullable field when the model must supply an explicit absence value. Local Zod parsing still validates the final value. Use prompted output when the provider must receive the schema's input shape without this native normalization.

### Prompted output

Use `outputType: { mode: 'prompted', schema: answerSchema }` to ask for JSON in the prompt and validate the returned text locally. The provider does not enforce a native output schema. Prompted output parses the JSON value directly, without a `response` wrapper. It supports open maps and synchronous Zod transforms or refinements when Zod can represent the schema's input as JSON Schema. Final-output validation uses synchronous parsing. Asynchronous transforms and refinements are unsupported.

### Retry invalid prompted output

Set `outputType: { mode: 'prompted', schema: answerSchema, maxRetries: 1 }` to allow one additional formatting attempt after local validation fails. The budget must be a nonnegative safe integer. Omit it, pass `undefined`, or use `0` to validate the original output once.

- An explicit native declaration rejects the `maxRetries` key, including `maxRetries: undefined`.
- Sessions opened with `storage` reject a positive repair budget before a model request, both at opening and when you select a contract for one root. This applies to [native local profiles](local-state.md) and [custom Session stores](session-store.md).

#### Repair resources and effects

Each repair has been opening a fresh plain Session with fixed formatting instructions, the captured schema, and the latest invalid text. It has been borrowing the original provider connection and credentials and forwarding only the accepted model, reasoning effort, reasoning summary, service tier, and invocation deadline. Each correction has been starting its own invocation clock with the full accepted deadline. The formatter has been using its defaults for output caps, sampling, tool choice, cache, metadata, and storage. Configure the API key before opening the original Session. Without a captured key, repair fails before opening another Session.

The repair Session receives no original task instructions, history, application context, tools, Environment, MCP, child-agent, goal, or storage grants. The original task and its effects run once. Compaction and provider, tool, policy, callback, or cleanup failures do not trigger repair.

The original root keeps its FIFO position until repair, receipt collection, and cleanup settle. Repeated waits observe the same work. Force cancellation stops the active correction; graceful stop can accept a valid current result but prevents another attempt. Closing the Session joins correction cleanup, and incomplete cleanup keeps close retryable. Root-only stops leave independent children under their own lifecycle. Repair does not accept steering input.

#### Read repair results

Successful completion exposes `repairAttempts`, detached records of the actual correction turns with their IDs, status, usage, and original-parent links. Session `items()` and `turns()` also expose passive repair history. `Completed.threadUsage` still reports the original conversation's usage separately. No attempt means an empty array; absent attempt usage remains null.

If validation still fails after the budget is exhausted, `OutputValidationError.rawOutput` contains the latest invalid text. The error's fixed message excludes that text. Rejected text and repair history may contain sensitive data. Choose where to store or display them.

Access `error.issues` deliberately to inspect the captured validator's codes and paths without validating again. Each issue has `code` and `path`; for example, `['items', 0, 'count']` identifies the first item's count. Native non-object roots omit the SDK's `response` prefix. Wrapper-only failures, invalid JSON, and arbitrary application-parser exceptions use the root path `[]`. Non-Zod failures use the generic `validation_error` code. The SDK retains no validator exception or message as an error cause. Codes and field names can contain private data, so keep `issues` out of routine logs just like `rawOutput`. Ordinary error display excludes both fields.

These options apply to the native prompted-output route. The classic API keeps its own behavior. When [migrating a workflow](migration.md), validate its output contract against the selected native mode.

The [output modes example](../output-modes.ts) shows a native greeting and prompted greetings keyed by name. Call its `runOutputModes()` function from an async application with a built native addon and configured model credentials. The example handles validation errors without printing rejected text.

### Override output for one turn

`session.submit(input, { outputType })` always starts a new root and rejects a busy Session. Keep the returned `Turn`. Its `wait()` returns the inferred value and follows automatic continuations. The next ordinary `submit` uses the opening default again.

### Queue independent turns

`session.enqueue(input, { outputType })` registers FIFO work and returns its exact Turn before native admission. Omit `outputType` to capture the Session default. Both methods infer the selected output type.

A queued Turn has `turnId: string | null` and an immediate `submissionId`. On admission, `turnId` becomes the initial native ID. Submitted Turns keep string IDs after native admission. `submit` rejects while busy. Choose `enqueue` for independent work or `turn.steer` for new input to the active root.

Enqueue captures input and output before it returns. The next root starts after the current root's automatic or manual continuations, entered callbacks, and any repair and cleanup settle. Waiting on a later entry leaves the order intact.

- Cancel a queued Turn to withdraw that entry alone.
- `Session.interrupt` discards pending entries after validating its options. For active work it returns on stop acceptance.
- Close discards pending entries. Updates, compaction, and state capture reject while entries are queued.

If you force-cancel before the SDK receives the native admission acknowledgment, the SDK closes the Session and fails pending work. Core may already have started the operation, so completed effects remain.

### Wait, steer, and reply on an overridden turn

Pass the per-turn `outputType` in the same options object as tool selection and other operation options.

Keep the Turn returned for the overridden root and use it throughout that operation:

- Await `turn.wait()` for its typed result. `session.wait()` rejects for this root, including after completion.
- Use `turn.steer()` for input while it runs. In `0.22.0-alpha.2`, use [exact native-step steering](sessions.md#steer-a-logical-root-or-one-native-step) when the input must target a captured step. Implicit busy steering through `session.submit(input)` rejects.
- Deliver manual replies with `session.respond(reply)`, which returns no final result. Result-returning `session.submit(reply)` rejects.

A later default submission restores the ordinary shortcuts. Default-only submissions keep their result types.

The [output overrides example](../output-overrides.ts) runs native, prompted, and manual operations in one open Session, then returns to its default.

To suspend a settled manual request, save it with its selected root contract. Plain text, prompted JSON, and native structured output all support this path. Restore with a matching declaration, including the repair budget. Then capture `restored.restoredTurn`, deliver the new request's reply with `restored.respond()`, and await that Turn for the typed result. `restoredTurn` is null when opening did not restore a pending manual root. A per-operation choice makes a formatting request only when prompted validation fails and the selected budget permits repair.

Usage reports native cumulative thread totals separately from the latest response. See [retained response usage](state.md#read-retained-response-usage) for provider observations, unknown counters, and their relationship to Turn success.

## Reusable output choices

See the [typed context example](../typed-context.ts) for a complete agent with typed output.

`agent.withOutputType(schema)` returns an `AgentOutput` view with typed `run()` and `session()` methods. It fixes the output choice without changing `agent.outputType` or calling the Agent constructor again. Other Agent defaults remain live until each opening captures them. Each call has its own output choice, so separate views can open concurrently. Restore portable state through a view with the matching output contract.

```ts
import { Agent, NativeProvider } from '@openai/agents';
import { z } from 'zod';

await using provider = new NativeProvider();
const agent = new Agent({ instructions: 'Answer clearly.', provider });
const counts = agent.withOutputType(z.object({ count: z.number() }));
const result = await counts.run('Count the items.', { returnState: true });
console.log(result.finalOutput.count);
await using restored = await counts.session({ state: result.state! });
```

The owned run closes its Session before returning. The restored Session's disposal scope closes it before the shared provider. See [provider lifetime](session-configuration.md#provider-lifetime).

A view exposes its fixed `outputType`, `run()` and `session()`. It is not an Agent instance and does not expose application subclass methods. The view captures the mode, schema and retry fields in an output-mode wrapper when it is created. `session.submit(input, { outputType })` and `session.enqueue(input, { outputType })` select output for individual operations.

### Output policies in subclasses

Subclasses refuse output-view execution by default, before invoking their run/session hooks or acquiring a provider. Opt in only when all hooks forward opening options and do not assume the Agent's original result type. Hooks run on the original Agent and share its private fields, counters, and policy references across views.

Use `this.outputTypeFor(options)` in output policies. It reports the captured opening declaration during deferred reopening, even if the Agent defaults changed. It excludes separate per-operation output overrides. `this.outputType` reports the Agent default.

```ts
import { Agent, type SessionOptions } from '@openai/agents';

class PolicyAgent extends Agent {
  protected override supportsOutputVariants(): boolean {
    return true;
  }

  override async session(options: SessionOptions = {}) {
    const output = this.outputTypeFor(options);
    if (output && 'mode' in output && output.mode === 'prompted') {
      throw new Error('This application requires native output.');
    }
    return super.session({ ...options });
  }
}
```

Forward options unchanged or with object spread, including when a hook awaits application policy. Do not opt in a hook that parses final output using the old Agent type or checks only `this.outputType`. An opted-in subclass also admits its derived subclasses, whose hooks must follow the same contract. This explicit contract keeps hooks on the original receiver. It does not copy an application object or its private state.
