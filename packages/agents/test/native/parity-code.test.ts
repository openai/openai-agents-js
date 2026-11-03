import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type ToolContext } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('runs an async application tool through native programmatic tool calling', async () => {
  const context = { value: 42 };
  let seen: ToolContext<typeof context> | undefined;
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        call_id: 'cell-1',
        name: 'exec',
        input: 'text("RESULT:" + await tools.lookup({key:"a"}));',
      },
    ],
    (request) => {
      expect(JSON.stringify(request.input)).toContain('RESULT:42');
      return [message('done')];
    },
  ]);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
  const definedTool = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    execute: async (_args, info: ToolContext<typeof context>) => {
      await Promise.resolve();
      seen = info;
      return info.context.value;
    },
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    model: 'gpt-5.5',
    provider,
    tools: [definedTool],
    programmaticToolCalling: true,
  });
  try {
    const result = await agent.run('Read a', { context });
    expect(result.finalOutput).toBe('done');
    expect(seen?.context).toBe(context);
    expect(seen?.submission).toBe(result.turn);
  } finally {
    await provider.close();
  }
  server.assertExhausted();
}, 30000);
