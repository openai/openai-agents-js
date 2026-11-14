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

Use `AiSdkModel` to borrow an AI SDK language model. Worker text runs accept a text prompt and direct standalone functions with text output. Pass an `observe` callback to receive normalized model events from a streaming adapter as they arrive. Pass `session: { id, store }` to save completed turns and reuse their history. The `SessionStore` grants an exclusive writer lease and atomically commits each revision. Keep the stored snapshots private to the application. Worker snapshots are distinct from Node session snapshots. Use the `agents` option to give each Worker Agent profile its own model, instructions, and tools. Each profile lists its named handoffs to other current profiles. The Rust controller checks the transfer against those declarations and stores the active profile with the completed turn. A handoff must be the only call in a model response. Sandbox tools and resumable approvals require additional runtime support.
