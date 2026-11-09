# Make typed decisions

Use `agent.decide()` or `ctx.decide()` for a boolean, a choice, or a structured value. A decision provider sends the request. The SDK validates raw JSON before applying the requested output type. Configure the provider on an Agent or override it for one bound call.

Decisions support is not in the latest published preview. [Build the matching source](building.md) and set `OPENAI_API_KEY` before running these examples.

## Return a typed value

```ts
import { Agent, OpenAIDecisions } from '@openai/agents';
import { z } from 'zod';

const agent = new Agent({
  instructions: 'Help classify support tickets.',
  decisions: new OpenAIDecisions(),
});
const TicketDecision = z.object({
  category: z.enum(['billing', 'technical', 'other']),
  urgent: z.boolean(),
});

const result = await agent.decide('Classify this support ticket.', {
  input: 'I was charged twice for my subscription.',
  outputType: TicketDecision,
});
console.log(result.category, result.urgent);
```

Omit `outputType` for a boolean. Pass `choices: ['billing', 'technical', 'other'] as const` to return one of those values. `choices` and `outputType` are mutually exclusive. Every call requires explicit `input`: text or an array of model input items. The SDK does not add conversation history or Agent instructions implicitly.

The built-in provider uses the supported Decisions backend without a model-selection option. A boolean answer uses a probability threshold of `0.5`. Typed objects can contain supported finite choices, booleans, bounded scores, and nested records. The provider rejects unsupported schemas before sending a request.

## Bind a provider to an Agent

The `decisions` setting is separate from the Agent's generative `model` and `provider`. This example checks a proposed answer before accepting it. A failed check requests one continuation of the same turn.

```ts
import { Agent, NativeProvider, OpenAIDecisions } from '@openai/agents';

await using provider = new NativeProvider();
const agent = new Agent({
  instructions: 'Help the user troubleshoot their connection.',
  provider,
  decisions: new OpenAIDecisions(),
  beforeComplete: async (ctx) => {
    const accepted = await ctx.decide(
      'Does the answer explain both the cause and a practical next step?',
      { input: ctx.text ?? '' },
    );
    if (accepted) return;
    if (ctx.continuationCount >= 1) {
      throw new Error('The answer did not pass its completion check');
    }
    return {
      action: 'continue',
      instructions: 'Explain the cause and give a practical next step.',
    };
  },
});

const result = await agent.run('Why does my Wi-Fi keep disconnecting?');
console.log(result.finalOutput);
```

Before-step, request-preparation, function-tool, native-agent approval, and completion callbacks inherit the captured Agent provider through `ctx.decide()`. Await each decision in its callback. A yielded tool can still decide after the root turn completes while its own callback remains live. Once the callback returns, its saved helper expires. Cancellation signals propagate to the provider. The helper does not add its question or answer to the conversation.

`beforeComplete` receives proposed text before output validation. Returning `undefined` accepts it. Returning `{ action: 'continue', instructions }` adds feedback to the conversation and continues the same turn. Returning `{ action: 'stop' }` stops the issuing turn. The hook also receives terminal tool proposals through `finalOutput` and `toolCall`. When prompted output needs repair, the original hook checks each repaired candidate with its original context. Already streamed text remains visible and recorded. The callback does not run after a provider error or cancellation. Bound continuations with a count check or a run budget.

## Replace the provider

Any object implementing `DecisionProvider.getDecision(request, { signal })` can replace `OpenAIDecisions`. It receives `question`, explicit `input`, and `outputSchema`, and returns `value` with optional `usage`, `requestId`, and `model`. Return the JSON value described by the schema: a boolean schema needs `true` or `false` directly.

The SDK closes object schemas: all declared fields are required, defaults are removed, and extra properties are disallowed. It validates the returned JSON against that schema before applying Zod transforms or defaults. Honor the supplied abort signal and finish the provider's work before returning.

Use the provider through `agent.decide(...)` or callback helpers. `agent.decide()` does not open a run or use history. Agent defaults are captured when opening starts and stay fixed for that Session. A handoff target can define its own default. A helper's `provider` option selects a provider for one call. Provider objects and credentials are not serialized into saved state.

## Use the bounded backend

`OpenAIDecisions` supports bounded output schemas. It rejects unsupported schemas locally, before sending a request. Use ordinary Agent model calls for generative work. To reuse OpenAI connection options, pass `new OpenAIDecisions({ client })` with an OpenAI client from `openai` version 7.30.0 or later. Ordinary transport retries follow that client's settings.

## Handle errors and usage

A refusal, malformed service answer, or non-JSON provider value raises `DecisionError`. Its `reason` is `refusal` or `invalid_response`. It retains trustworthy usage and request metadata without retaining the response body. Malformed successful HTTP responses also preserve the request ID. Valid JSON that fails the advertised schema raises the existing `OutputValidationError`; Zod parsing runs only after that validation. Transport errors keep the OpenAI client's exception types.

When tracing is active, each call has a `decision` span. A separate `decision.usage` child span records completed usage and request metadata without the question, input, schema, or value. Missing or invalid usage stays unknown. Optional usage recording is best effort and preserves the decision's result or original error; cancellation and failures of the main span still propagate. Decisions usage does not change the root turn's token totals or consume its model-step budget. The decision still follows its callback's lifetime and cancellation signal.
