import { Agent, Runner } from '@openai/agents';

const runner = new Runner();

const agent = new Agent({
  name: 'Greeter',
  instructions: 'Respond with a short greeting.',
});

const tracingApiKey =
  process.env.OPENAI_TRACING_API_KEY ??
  process.env.OPENAI_API_KEY ??
  'sk-tracing-...';

const result = await runner.run(agent, 'Hello!', {
  tracing: {
    apiKey: tracingApiKey,
  },
});

console.log(result.finalOutput);
