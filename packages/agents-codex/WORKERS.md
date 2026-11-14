# Text runs in Cloudflare Workers

Load `@openai/agents/worker` and its Rust WebAssembly module in a Worker with Node.js compatibility. The module owns the turn and issues model requests and local function calls. Your Worker supplies the model adapter and executes the functions you declare.

```ts
import control from '@openai/agents/worker/control.wasm';
import {
  runWorkerText,
  standaloneTool,
  ResponsesModel,
} from '@openai/agents/worker';
import OpenAI from 'openai';

const lookup = standaloneTool({
  name: 'lookup',
  description: 'Look up a value in this Worker.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  execute: ({ key }) => `Value for ${key}`,
});

export default {
  async fetch(request: Request, env: { OPENAI_API_KEY: string }) {
    const provider = new ResponsesModel(
      new OpenAI({ apiKey: env.OPENAI_API_KEY }),
    );
    const text = await runWorkerText('Look up status.', {
      control,
      provider,
      model: 'gpt-5.5',
      instructions: 'Use the local lookup tool.',
      tools: [lookup],
      signal: request.signal,
    });
    return new Response(text);
  },
};
```

Use `AiSdkModel` to borrow an AI SDK language model. Worker text runs accept a text prompt and direct standalone functions with text output. Pass an `observe` callback to receive normalized model events from a streaming adapter as they arrive. Pass `session: { id, store }` to save completed turns and reuse their history. The `SessionStore` grants an exclusive writer lease and atomically commits each revision. Keep the stored snapshots private to the application. Worker snapshots are distinct from Node session snapshots. Use the `agents` option to give each Worker Agent profile its own model, instructions, and tools. Each profile lists its named handoffs to other current profiles. The Rust controller checks the transfer against those declarations and stores the active profile with the completed turn. A handoff must be the only call in a model response. Sandbox tools require a native Node runtime.


## Pause a turn for approval

Set `approve` to a map from tool names to callbacks. Return `true` to run a tool, or `false` to send a denial to the model without running the tool. When you use `runWorkerTurn` with a session store, you can return `null` to pause before the tool runs.

```ts
import { runWorkerTurn } from '@openai/agents/worker';

const options = {
  control,
  provider,
  model: 'gpt-5.5',
  instructions: 'Use the local lookup tool.',
  tools: [lookup],
  session: { id: sessionId, store },
  approve: { lookup: () => null },
};

const pending = await runWorkerTurn('Look up status.', options);
// After authenticating the caller and checking they can decide for this session:
if (pending.type === 'approval') {
  const result = await runWorkerTurn(
    { callId: pending.callId, revision: pending.revision, approved: true },
    options,
  );
}
```

Pass the same session ID and tool declarations when resuming from another request. The call ID and revision tie the decision to the pending request. Each approval currently requires its own model response. The SDK records an approved call before dispatch. If the tool result cannot be saved after dispatch, the SDK refuses to repeat the call because it cannot know whether the original side effect occurred.

## Guard input and output

Use `inputGuardrails` to check a new text prompt before the first model request. Use `outputGuardrails` to check final text before the SDK returns it or commits the completed turn. Each check declares a `name` and a `callback` that receives the text, context, signal, and current profile. Return `{ tripwireTriggered: true, outputInfo }` to stop the turn. Catch `WorkerGuardrailTripwire` to inspect the check and its result.

You can attach checks to the run or to an Agent profile. Input checks use the profile active at submission. Output checks use the profile that finishes the turn. A streaming observer can receive model events before the output checks finish, so display accepted text from the run result.

Use `toolGuardrails` to check calls to a named local tool. A `before` callback receives the admitted call before the function body, and an `after` callback also receives its text output. Return `{ action: 'allow' }` to continue, `{ action: 'deny', reason }` to send a replacement message to the model, or `{ action: 'stop', outputInfo }` to stop the turn. An output check runs after the function, so any external effects have already happened.
