import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  toolRef,
  type ModelRequest,
  type UserMessage,
} from '../../src';

it('preserves admitted mixed audio content through one native tool continuation', async () => {
  const seen: ModelRequest[] = [];
  const effects: string[] = [];
  const message: UserMessage = {
    role: 'user',
    content: [
      { type: 'input_text', text: 'before' },
      { type: 'input_audio', audio_url: 'data:audio/wav;base64,UklGRg==' },
      { type: 'input_text', text: 'after' },
    ],
  };
  const lookup = tool({
    name: 'lookup',
    description: 'Lookup.',
    parameters: z.object({}),
    execute() {
      effects.push('lookup');
      return 'found';
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(request) {
        seen.push(request);
        return {
          output:
            seen.length === 1
              ? [
                  {
                    type: 'function_call',
                    name: 'lookup',
                    call_id: 'call_audio',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'ok' }],
                  },
                ],
        };
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use lookup once.',
    tools: [lookup],
    provider,
    modelSettings: { toolChoice: toolRef('lookup') },
  }).run(message);
  expect(result.finalOutput).toBe('ok');
  expect(effects).toEqual(['lookup']);
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    const original = (request.body.input as any[]).find(
      (item) => item.role === 'user',
    );
    expect(original.content).toEqual(message.content);
  }
  expect(
    (seen[1].body.input as any[]).some(
      (item) => item.type === 'function_call_output',
    ),
  ).toBe(true);
});
