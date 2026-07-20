import { createDeepSeek } from '@ai-sdk/deepseek';
import { Agent, getGlobalTraceProvider, run, tool } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions/ai-sdk';
import { z } from 'zod';

const requestBodies: Array<Record<string, unknown>> = [];
const deepseek = createDeepSeek({
  apiKey: 'integration-test-key',
  fetch: async (_input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected the DeepSeek request body to be a string.');
    }

    const body = JSON.parse(init.body) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length === 2) {
      const messages = body.messages;
      const toolResultMessage = Array.isArray(messages)
        ? messages.find(
            (message) =>
              typeof message === 'object' &&
              message !== null &&
              'role' in message &&
              message.role === 'tool',
          )
        : undefined;

      if (
        !toolResultMessage ||
        toolResultMessage.tool_call_id !== 'call-weather' ||
        toolResultMessage.content !== 'Berlin is sunny.'
      ) {
        throw new Error(
          'Expected the second request to contain the matching weather tool result.',
        );
      }
    }

    const response =
      requestBodies.length === 1
        ? {
            id: 'response-tool-call',
            created: 1,
            model: 'deepseek-chat',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-weather',
                      function: {
                        name: 'get_weather',
                        arguments: '{"city":"Berlin"}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }
        : {
            id: 'response-final',
            created: 2,
            model: 'deepseek-chat',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Berlin is sunny.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 4,
              total_tokens: 24,
            },
          };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city} is sunny.`,
});

const agent = new Agent({
  name: 'AI SDK v4 Test Agent',
  instructions: 'Use get_weather to answer the question.',
  tools: [getWeatherTool],
  model: aisdk(deepseek('deepseek-chat')),
});

try {
  const result = await run(agent, 'What is the weather in Berlin?');

  if (requestBodies.length !== 2) {
    throw new Error(
      `Expected two model requests, got ${requestBodies.length}.`,
    );
  }

  const firstTools = requestBodies[0]?.tools;
  if (!Array.isArray(firstTools) || firstTools.length !== 1) {
    throw new Error('Expected the first request to include one function tool.');
  }

  console.log(`[AISDK_V4_RESPONSE]${result.finalOutput}[/AISDK_V4_RESPONSE]`);
} finally {
  await getGlobalTraceProvider().shutdown();
}
