// @ts-check

const { Agent, Runner } = require('@openai/agents');
const { aisdk } = require('@openai/agents-extensions');

const fakeModel = {
  provider: 'fake',
  modelId: 'fake-model',
  async doGenerate() {
    return {
      content: [{ type: 'text', text: 'hello' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      providerMetadata: {},
    };
  },
};

const agent = new Agent({
  name: 'AISDK Agent',
  instructions: 'Respond with a short greeting.',
  model: aisdk(fakeModel),
});

const runner = new Runner({ tracingDisabled: true });

async function main() {
  const result = await runner.run(agent, 'ping');
  console.log(`[AISDK_RESPONSE]${result.finalOutput}[/AISDK_RESPONSE]`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
