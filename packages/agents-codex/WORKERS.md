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
import { z } from 'zod';

const lookup = standaloneTool({
  name: 'lookup',
  description: 'Look up a value in this Worker.',
  parameters: z.strictObject({ key: z.string() }),
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

## Choose model input and tools

Worker runs have been accepting a text prompt or a user message containing text, images, and files. The SDK has been accepting remote media URLs only over HTTPS without embedded credentials. It has not been fetching media, uploading files, or reading local paths for the application.

Direct standalone functions have been returning text or supported media content. Tools with `finishTurn: true` have been requiring text output. Sandbox tools have been requiring a native Node runtime.

`AiSdkModel` has been adapting an AI SDK language model. An `observe` callback has been receiving normalized model events from a streaming adapter as they arrive.

## Retain conversation history

The `session: { id, store }` option has been saving completed turns and reusing their history. The application-supplied `SessionStore` has been granting an exclusive writer lease and committing each revision atomically. Keep the stored snapshots private to the application. Worker snapshots have been using a separate format from Node session snapshots.

## Transfer between Agent profiles

The `agents` option has been giving each Worker Agent profile its own model, instructions, and tools. Each profile has been declaring named handoffs to other current profiles. The Rust controller has been checking transfers against those declarations and saving the active profile with the completed turn. A handoff has been requiring a model response containing only that call.

## Pause a turn for approval

Set `approve` to a map from tool names to callbacks. Return `true` to run a tool, or `false` to send a denial to the model without running the tool. When you use `runWorkerTurn` with a session store, you can return `null` to pause before the tool runs.

The following fragment has been assuming the preceding `control` and `lookup` declarations, a model `provider` created in the request handler, and an application-owned `sessionId` and `store`.

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

Pass the same session ID and tool declarations when resuming from another request. The call ID and revision tie the decision to the pending request. When a model response contains several calls, the Worker runs ungated tools first and presents one pending approval at a time. It saves results from settled calls in the checkpoint and returns all results to the model in the original order. The SDK records an approved call before dispatch. If the tool result cannot be saved after dispatch, the SDK refuses to repeat the call because it cannot know whether the original side effect occurred.

## Guard input and output

`inputGuardrails` have been checking new input before the first model request. An input check with `runInParallel: true` has been overlapping that request while still gating tool execution and turn acceptance. `outputGuardrails` have been checking final text before the SDK returns it or commits the completed turn.

Each check has been declaring a `name` and a `callback`. The callback has been receiving `text`, application `context`, an abort `signal`, the current `profile`, `sessionId`, and `turnId`. Input checks have also been receiving detached `input` containing the complete submitted user message. For media messages, `text` has been joining only text parts with newlines; media-only input has been producing an empty string. Inspect `input` when checking images or files. Output checks have been receiving final text without an `input` field.

Returning `{ tripwireTriggered: true, outputInfo }` has been stopping the turn with `WorkerGuardrailTripwire`, which has been identifying the check and its result.

You can attach checks to the run or to an Agent profile. Input checks use the profile active at submission. Output checks use the profile that finishes the turn. A streaming observer can receive model events before the output checks finish, so display accepted text from the run result.

`toolGuardrails` have been checking calls to a named local tool. A `before` callback has been receiving the admitted call before the function body. An `after` callback has also been receiving string `output`; for media results, it has been receiving the serialized provider content in `output` and detached native content in `response.contentItems`.

Returning `{ action: 'allow' }` has been allowing execution or output delivery. Returning `{ action: 'deny', reason }` has been sending a replacement message to the model, and `{ action: 'stop', outputInfo }` has been stopping the turn. An `after` check has been running after the function and any external effects.
