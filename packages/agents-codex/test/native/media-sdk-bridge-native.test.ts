import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolOutput,
  tool,
  type SessionState,
  parseSessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const references = [
  { file_id: 'opaque-document' },
  { file_data: 'data:application/pdf;base64,JVBERi0xLjcK' },
  { file_url: 'https://files.invalid/document.pdf' },
] as const;

for (const reference of references) {
  it(`preserves user/tool ${Object.keys(reference)[0]} through current and portable restore without effect replay`, async () => {
    const server = new ModelServer([
      [call('picture', {}, { callId: 'media-call' })],
      [message('accepted')],
      [message('restored')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-media-bridge',
      supportsWebsockets: false,
    });
    const effects: string[] = [];
    const toolParts = [
      { type: 'inputText' as const, text: 'before' },
      {
        type: 'inputImage' as const,
        fileId: 'opaque-tool-image',
        detail: 'low' as const,
      },
      { type: 'inputFile' as const, ...reference, filename: 'tool.pdf' },
      { type: 'inputText' as const, text: 'after' },
    ];
    const picture = tool({
      name: 'picture',
      parameters: z.object({}),
      execute: () => {
        effects.push('once');
        return new ToolOutput(toolParts);
      },
    });
    const agent = new Agent({
      instructions: 'Use picture once.',
      model: 'gpt-5.5',
      tools: [picture],
      provider,
    });
    const content = [
      {
        type: 'input_image' as const,
        file_id: 'opaque-user-image',
        detail: 'low' as const,
      },
      { type: 'input_file' as const, ...reference, filename: 'user.pdf' },
    ];
    const expectedOutput = [
      { type: 'input_text', text: 'before' },
      { type: 'input_image', file_id: 'opaque-tool-image', detail: 'low' },
      { type: 'input_file', ...reference, filename: 'tool.pdf' },
      { type: 'input_text', text: 'after' },
    ];
    let state: SessionState;
    {
      await using session = await agent.session();
      const result = await (
        await session.submit({ role: 'user', content })
      ).wait();
      expect(result.finalOutput).toBe('accepted');
      expect(server.requests[0].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content }),
        ]),
      );
      expect(server.requests[1].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'media-call',
            output: expectedOutput,
          }),
        ]),
      );
      const items = [];
      for await (const item of session.items()) items.push(item);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content }),
          expect.objectContaining({
            type: 'function_call_output',
            output: expectedOutput,
          }),
        ]),
      );
      state = parseSessionState(JSON.stringify(await session.saveState()));
    }
    {
      await using restored = await agent.session({ state });
      const items = [];
      for await (const item of restored.items()) items.push(item);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content }),
          expect.objectContaining({
            type: 'function_call_output',
            output: expectedOutput,
          }),
        ]),
      );
      expect(
        (
          await (
            await restored.submit('continue without repeating picture')
          ).wait()
        ).finalOutput,
      ).toBe('restored');
      expect(server.requests[2].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'media-call',
            output: expectedOutput,
          }),
        ]),
      );
    }
    expect(effects).toEqual(['once']);
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  }, 30_000);
}
