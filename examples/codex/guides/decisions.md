# Make typed decisions

Use `agent.decide()` or `ctx.decide()` for a boolean, a choice, or a structured value. A decision provider sends the request. The SDK validates the result as it validates Agent output. Configure the provider on an Agent or override it for one bound call.

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

Before-step, request-preparation, function-tool, native-agent approval, and completion callback contexts inherit the captured provider through `ctx.decide()`. Await the call in its live callback. Saved contexts cannot use an expired callback's authority. Completed usage contributes to the owning turn; child usage stays with the child. Run budgets check limits before admitting a root model step. An admitted request may finish after reaching a limit. Decision calls do not add root request admissions. Cancellation signals propagate to providers, and the Session joins started work. The helper does not append its question or answer to the conversation.

`beforeComplete` receives proposed text before output validation. Returning `undefined` accepts it. Returning `{ action: 'continue', instructions }` adds feedback to the conversation and continues the same turn. Returning `{ action: 'stop' }` stops the issuing turn. The hook also receives terminal tool proposals through `finalOutput` and `toolCall`. When prompted output needs repair, the original hook checks each repaired candidate with its original context. Already streamed text remains visible and recorded. The callback does not run after a provider error or cancellation. Bound continuations with a count check or a run budget.

## Replace the provider

Any object implementing `DecisionProvider.getDecision(request, { signal })` can replace `OpenAIDecisions`. It receives a `DecisionRequest` with `question`, `input`, and `outputSchema`, and returns a `DecisionResponse` with `value` and optional `usage`, `requestId`, and `model`. Return JSON matching the supplied schema; scalar outputs use the schema's `response` wrapper. The SDK validates and unwraps that value for the caller. Honor the supplied abort signal and settle all work before returning.

Use the same provider through `agent.decide(...)` or callback helpers. `agent.decide()` does not open a run or use history. `OpenAIDecisions` implements the provider protocol; the Agent and its callback contexts expose the typed decision methods.

An explicit `decisions` on `agent.run()` or `agent.session()` overrides the Agent default for that whole opening. Otherwise a handoff target's explicit provider takes precedence over the root Agent default. A helper's `provider` overrides either for one call. Provider selection is captured when opening starts and stays fixed for that Session. Provider objects and credentials are not serialized into saved state.

## Choose an explicit generative fallback

Free-form text and other unbounded schemas need a generative request. Configure `new OpenAIDecisions({ fallbackModel: ... })` to send the whole unsupported schema through Responses. The provider chooses the API before inference. It does not first make a Decisions request or retry a low-confidence answer. Ordinary transport retries follow the supplied OpenAI client's settings. Pass that client as `new OpenAIDecisions({ client })` to reuse its connection options.

## Handle errors and usage

A refusal, malformed service answer, or non-JSON provider value raises `DecisionError`. Its `reason` is `refusal` or `invalid_response`; it retains trustworthy usage and request metadata without retaining the response body. Bound helpers record completed usage before raising. Valid JSON that fails the requested output type raises the existing `OutputValidationError`, as Agent output does. Both failures remain available if recording a completed error also fails. Missing or invalid usage stays unknown. Transport errors keep the OpenAI client's exception types. If a schema is unsupported and no fallback is configured, the call fails before any request.
