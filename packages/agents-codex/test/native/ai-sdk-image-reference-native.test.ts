import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AiSdkModel, NativeProvider, ToolOutput, tool } from '../../src';

function response(output: unknown[], id: string) {
  return {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-5',
    output,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      total_tokens: 3,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}
it.each([false, true])(
  'continues and restores an image-reference turn (stream=%s)',
  async (stream) => {
    const wires: Record<string, unknown>[] = [];
    let executions = 0;
    const server = createServer(async (request, reply) => {
      let bytes = '';
      for await (const chunk of request) bytes += chunk;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/responses');
      const body = JSON.parse(bytes);
      wires.push(body);
      const output =
        wires.length === 1
          ? [
              {
                type: 'function_call',
                id: 'fc-image',
                call_id: 'call-image',
                name: 'supply_image',
                arguments: '{}',
                status: 'completed',
              },
            ]
          : [
              {
                type: 'message',
                id: 'msg-done',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'image accepted',
                    annotations: [],
                  },
                ],
              },
            ];
      const completed = response(output, 'resp-image-' + wires.length);
      if (body.stream) {
        reply.writeHead(200, { 'content-type': 'text/event-stream' });
        let sequence = 0;
        const emit = (event: Record<string, unknown>) =>
          reply.write(
            'data: ' +
              JSON.stringify({ ...event, sequence_number: sequence++ }) +
              '\n\n',
          );
        emit({
          type: 'response.created',
          response: { ...completed, status: 'in_progress', output: [] },
        });
        const item = output[0];
        if (item.type === 'function_call') {
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, arguments: '' },
          });
          emit({
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: 0,
            delta: '{}',
          });
          emit({
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: 0,
            arguments: '{}',
          });
        } else {
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          });
          emit({
            type: 'response.content_part.added',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          emit({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: 'image accepted',
          });
          emit({
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            text: 'image accepted',
          });
          emit({
            type: 'response.content_part.done',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: {
              type: 'output_text',
              text: 'image accepted',
              annotations: [],
            },
          });
        }
        emit({ type: 'response.output_item.done', output_index: 0, item });
        emit({ type: 'response.completed', response: completed });
        reply.end();
      } else {
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(JSON.stringify(completed));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing listener');
    const openai = createOpenAI({
      apiKey: 'local-fixture',
      baseURL: 'http://127.0.0.1:' + address.port + '/v1',
    });
    try {
      await using provider = new NativeProvider({
        modelBackend: new AiSdkModel(openai.responses('gpt-5'), {}, { stream }),
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Use the image.',
        tools: [
          tool({
            name: 'supply_image',
            parameters: z.strictObject({}),
            execute() {
              executions++;
              return ToolOutput.image({ fileId: 'file-image-owned' });
            },
          }),
        ],
      });
      let state;
      {
        await using session = await agent.session();
        const result = await (await session.submit('Show the image.')).wait();
        expect(result.finalOutput).toBe('image accepted');
        state = await session.saveState();
      }
      await using restored = await agent.session({ state });
      expect(
        (await (await restored.submit('Describe it again.')).wait())
          .finalOutput,
      ).toBe('image accepted');
      expect(executions).toBe(1);
      expect(wires).toHaveLength(3);
      for (const wire of wires.slice(1))
        expect(wire.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              call_id: 'call-image',
              output: [
                expect.objectContaining({
                  type: 'input_image',
                  file_id: 'file-image-owned',
                }),
              ],
            }),
          ]),
        );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
