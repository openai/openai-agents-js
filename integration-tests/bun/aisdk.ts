// @ts-check

import { Agent, Runner } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';

const fakeModel = {
  specificationVersion: 'v4',
  provider: 'fake',
  modelId: 'fake-model',
  async doGenerate() {
    return {
      content: [{ type: 'text', text: 'hello' }],
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      providerMetadata: {},
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
    };
  },
};

const agent = new Agent({
  name: 'AISDK Agent',
  instructions: 'Respond with a short greeting.',
  model: aisdk(fakeModel as any),
});

const runner = new Runner({ tracingDisabled: true });
const result = await runner.run(agent, 'ping');
console.log(`[AISDK_RESPONSE]${result.finalOutput}[/AISDK_RESPONSE]`);
