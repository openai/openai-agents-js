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

Use `AiSdkModel` to borrow an AI SDK language model. Worker text runs currently accept a text prompt, buffered model responses, and direct standalone functions with text output. Session persistence, streamed output, sandbox tools, and approval or handoff flows require additional runtime support.
