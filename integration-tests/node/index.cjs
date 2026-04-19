// @ts-check

const { Agent, getGlobalTraceProvider, run } = require('@openai/agents');

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
});

async function main() {
  try {
    const result = await run(agent, 'Hey there!');
    console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
  } finally {
    await getGlobalTraceProvider().shutdown();
  }
}

main().catch(console.error);
