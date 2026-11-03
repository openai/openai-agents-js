# Output contracts

Use plain text, native structured output, or prompted JSON. Configure a default for an Agent or select a contract for one turn.

## Choose an output mode

Set `outputType` to a Zod schema to request native structured output and validate the returned value. `Completed.finalOutput` retains the inferred output type. Omit `outputType`, or pass a bare unconstrained `z.string()`, for plain text.

### Native structured output

Use `outputType: { mode: 'native', schema: answerSchema }` to select native structured output explicitly. Native object schemas must be closed. Primitive and array outputs use an object with one required `response` field; the SDK unwraps that field before returning the result. Explicit native `z.string()` also uses this wrapper, while bare unconstrained `z.string()` returns plain text.

The SDK removes defaults from the model-visible native schema, closes object schemas and marks every declared property as required. A Zod optional or defaulted property therefore does not let the model omit that field. Use a nullable field when the model must supply an explicit absence value. Local Zod parsing still validates the final value. Use prompted output when the provider must receive the schema's input shape without this native normalization.

### Prompted output

Use `outputType: { mode: 'prompted', schema: answerSchema }` to ask for JSON in the prompt and validate the returned text locally. The provider does not enforce a native output schema. Prompted output parses the JSON value directly, without a `response` wrapper. It supports open maps and synchronous Zod transforms or refinements when Zod can represent the schema's input as JSON Schema. Final-output validation uses synchronous parsing. Asynchronous transforms and refinements are unsupported.

### Retry invalid prompted output

Add `maxRetries` only to an explicit prompted declaration, such as `outputType: { mode: 'prompted', schema: answerSchema, maxRetries: 1 }`. The budget counts additional formatting attempts after the original output fails local validation. Omitted, `undefined`, and `0` keep validation-only behavior. A supplied budget must be a nonnegative safe integer. An explicit native declaration rejects the presence of `maxRetries`, even with an `undefined` value. LocalStorage rejects a positive budget before a model request, both at opening and for a per-root override.

Each repair opens a fresh plain Session with fixed formatting instructions, the captured schema, and the latest invalid text. It uses the original provider connection and credentials plus the current accepted model settings. Configure the API key before opening the original Session. Without a captured key, repair fails before opening another Session.

The repair Session receives no original task instructions, history, application context, tools, Environment, MCP, child-agent, goal, or storage grants. The original task and its effects run once. Compaction and provider, tool, policy, callback, or cleanup failures do not trigger repair.

The original root keeps its FIFO position until repair, receipt collection, and cleanup settle. Repeated waits observe the same work. Force cancellation stops the active correction; graceful stop can accept a valid current result but prevents another attempt. Closing the Session joins correction cleanup, and incomplete cleanup keeps close retryable. Root-only stops leave independent children under their own lifecycle. Repair does not accept steering input.

Successful completion exposes `repairAttempts`, detached records of the actual correction turns with their IDs, status, usage, and original-parent links. Session `items()` and `turns()` also expose passive repair history. `Completed.usage` still reports the original conversation's usage separately. No attempt means an empty array; absent attempt usage remains null. If validation still fails after the budget is exhausted, `OutputValidationError.rawOutput` contains the latest invalid text. The error's fixed message excludes that text. Rejected text and repair history may contain sensitive data. Choose where to store or display them.

These options apply to the native prompted-output route. The classic API keeps its own behavior. The experimental selected Model migration route accepts text or supported Zod object output, but does not admit prompted repair. See [the adapter contract](../../CLASSIC.md#structured-final-output).

The [output modes example](../output-modes.ts) shows a native greeting and prompted greetings keyed by name. Call its `runOutputModes()` function from an async application with a built native addon and configured model credentials. The example handles validation errors without printing rejected text.

### Override output for one turn

`session.submitWithOutput(input, outputType)` always starts a new root and rejects a busy Session. Keep the returned `Turn`. Its `wait()` returns the inferred value and follows automatic continuations. The next ordinary `submit` uses the opening default again.

### Queue independent turns

`session.enqueue(input, outputType?)` registers FIFO work and returns its exact Turn before native admission. Omit the output contract to capture the Session default, or pass one accepted by `submitWithOutput`.

A queued Turn has `turnId: string | null` and an immediate `submissionId`. On admission, `turnId` becomes the initial native ID. Ordinary submit and submitWithOutput Turns keep string IDs and their current acknowledgment behavior. Legacy submit rejects `ifBusy: 'queue'`, including through an options alias.

Enqueue captures input and output before it returns. The next root starts after the current root's automatic or manual continuations, entered callbacks, and any repair and cleanup settle. Waiting on a later entry leaves the order intact.

- Cancel a queued Turn to withdraw that entry alone.
- `Session.interrupt` discards pending entries after validating its options. For active work it returns on stop acceptance.
- Close discards pending entries. Updates, compaction, and state capture reject while entries are queued.

If you force-cancel before the SDK receives the native admission acknowledgment, the SDK closes the Session and fails pending work. Core may already have started the operation, so completed effects remain.

### Wait, steer, and reply on an overridden turn

Legacy `submit` rejects an `outputType` field, including one hidden by an options alias; use `submitWithOutput` to select a contract.

For an overridden root, `session.wait()` rejects even after completion. Implicit busy steering through `session.submit(input)` and result-returning `session.submit(reply)` also reject for that root. Use the returned Turn's `wait()` and `steer()` methods, and deliver manual replies through `session.respond(reply)`, which returns no final result. A later default submission restores the ordinary shortcuts. Existing default-only submissions keep their result types and steering behavior.

The [persistent output example](../output-overrides.ts) runs native, prompted, and manual operations in one conversation, then returns to its default. Pending suspension uses the selected root contract: plain, prompted and native structured output support explicit settled manual suspension. Restore with a current declaration that matches the saved output contract, including its repair budget. Per-operation selection makes repair requests only when the selected prompted contract has a positive budget and validation fails. It adds no implicit one-shot prompted transfer.

Usage reports native cumulative thread totals separately from the latest response.

## Reusable output choices

See the [typed context example](../typed-context.ts) for a complete agent with typed output.

`agent.withOutputType(schema)` returns an `AgentOutput` view with typed `run()` and `session()` methods. It fixes the output choice without changing `agent.outputType` or calling the Agent constructor again. Other Agent defaults remain live until each opening captures them. Each call has its own output choice, so separate views can open concurrently. Restore portable state through a view with the matching output contract.

```ts
import { Agent } from '@openai/agents';
import { z } from 'zod';

const agent = new Agent({ instructions: 'Answer clearly.' });
const counts = agent.withOutputType(z.object({ count: z.number() }));
const result = await counts.run('Count the items.', { returnState: true });
console.log(result.finalOutput.count);
const restored = await counts.session({ state: result.state! });
await restored.close();
```

A view exposes its fixed `outputType`, `run()` and `session()`. It is not an Agent instance and does not expose application subclass methods. The view captures the mode, schema and retry fields in an output-mode wrapper when it is created. Existing `session.submitWithOutput()` and typed `session.enqueue()` still select output for individual operations.

### Output policies in subclasses

Subclasses refuse output-view execution by default, before invoking their run/session hooks or acquiring a provider. Opt in only when all hooks forward opening options and do not assume the Agent's original result type. Hooks run on the original Agent and share its private fields, counters, and policy references across views.

Use `this.outputTypeFor(options)` in output policies. It reports the captured opening declaration during deferred reopening, even if the Agent defaults changed. It excludes separate per-operation output overrides. `this.outputType` reports the Agent default.

```ts
import { type SessionOptions } from '@openai/agents';

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
