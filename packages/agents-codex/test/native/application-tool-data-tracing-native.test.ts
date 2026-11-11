import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, ToolOutput, telemetry, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-app-data',
    supportsWebsockets: false,
  });
}
nativeIt(
  'excludes application data from sensitive native trace export',
  async () => {
    const exported: unknown[] = [];
    await telemetry.configure({
      traceProcessors: [
        {
          onEvents(events) {
            exported.push(...events);
          },
        },
      ],
    });
    try {
      const model = new ModelServer([
        [call('record', {}, { callId: 'trace-data' })],
        [message('trace done')],
      ]);
      await using provider = await providerFor(model);
      await using session = await new Agent({
        instructions: 'Use the supplied tool.',
        provider,
        tools: [
          tool({
            name: 'record',
            parameters: z.object({}),
            execute: () =>
              new ToolOutput(
                [{ type: 'inputText', text: 'public-visible-trace' }],
                true,
                { ticket: 'private-trace-ticket' },
              ),
          }),
        ],
      }).session({
        tracing: { name: 'application-data-trace', includeSensitiveData: true },
      });
      const result = await (await session.submit('Record')).wait();
      expect(result.applicationToolOutputs?.[0]?.applicationData).toEqual({
        ticket: 'private-trace-ticket',
      });
      model.assertExhausted();
    } finally {
      expect((await telemetry.forceFlush()).status).toBe('success');
      await telemetry.shutdown();
    }
    const wire = JSON.stringify(exported);
    expect(exported).toContainEqual(
      expect.objectContaining({
        name: 'record',
        lifecycle: 'end',
        attributes: expect.objectContaining({
          call_id: 'trace-data',
          tool_name: 'record',
        }),
      }),
    );
    expect(wire).not.toContain('private-trace-ticket');
    expect(wire).not.toContain('applicationData');
  },
);
