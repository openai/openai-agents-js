import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HostedResponsesWebSocketModel,
  NativeProvider,
  hostedTool,
  tool,
} from '../../src';

it.each([
  'ordinary',
  'terminal-completion',
  'repeated-incomplete',
  'continued-progress',
  'terminal-identical',
] as const)(
  'projects a live Program and keeps %s output occurrences',
  async (mode) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const frames: Record<string, any>[] = [];
    const effects: string[] = [];
    let injections = 0;
    const program = {
      type: 'program',
      id: 'program_item',
      call_id: 'parent',
      code: 'lookup()',
      agent: { agent_name: '/worker' },
    };
    const call = {
      type: 'function_call',
      id: 'fc_lookup',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', caller_id: 'parent' },
    };
    const result = {
      type: 'program_output',
      id: 'program_output_item',
      call_id: 'parent',
      status: 'completed',
      result: 'synthetic result',
    };
    const incomplete = {
      ...result,
      id: 'program_output_progress',
      status: 'incomplete',
      result: 'partial',
    };
    if (mode === 'terminal-identical')
      delete (incomplete as { id?: string }).id;
    const final = {
      type: 'message',
      id: 'msg_root',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'done' }],
    };
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        if (frame.type === 'response.create') {
          send({
            type: 'response.created',
            response: { id: 'resp_program', output: [] },
          });
          send({
            type: 'response.output_item.done',
            output_index: 0,
            item: program,
          });
          send({
            type: 'response.output_item.done',
            output_index: 1,
            item: call,
          });
        } else if (frame.type === 'response.inject') {
          injections++;
          send({
            type: 'response.inject.created',
            response_id: 'resp_program',
          });
          if (mode === 'continued-progress' && injections === 1) {
            send({
              type: 'response.output_item.done',
              output_index: 2,
              item: incomplete,
            });
            send({
              type: 'response.output_item.done',
              output_index: 3,
              item: {
                ...call,
                id: 'fc_lookup_two',
                call_id: 'call_lookup_two',
              },
            });
            return;
          }
          const streamed =
            mode === 'continued-progress'
              ? []
              : mode === 'ordinary'
                ? [result]
                : mode === 'repeated-incomplete'
                  ? [incomplete, incomplete]
                  : [incomplete];
          for (const [index, item] of streamed.entries())
            send({
              type: 'response.output_item.done',
              output_index: 2 + index,
              item,
            });
          send({
            type: 'response.completed',
            response: {
              id: 'resp_program',
              status: 'completed',
              store: true,
              output: [
                program,
                call,
                ...(mode === 'continued-progress'
                  ? [
                      {
                        ...call,
                        id: 'fc_lookup_two',
                        call_id: 'call_lookup_two',
                      },
                    ]
                  : []),
                ...(mode === 'ordinary'
                  ? []
                  : mode === 'repeated-incomplete' ||
                      mode === 'terminal-identical'
                    ? [incomplete, incomplete]
                    : [incomplete]),
                result,
                final,
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          });
        } else socket.close();
      }),
    );
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    const model = new HostedResponsesWebSocketModel(
      (_, options) =>
        new ResponsesWS(client, {
          headers: options.headers as Record<string, string>,
        }),
      'gpt-5.5',
    );
    const projected: Record<string, any>[] = [];
    const stream = model.stream.bind(model);
    vi.spyOn(model, 'stream').mockImplementation(async function* (request) {
      for await (const part of stream(request)) {
        projected.push(part as Record<string, any>);
        yield part;
      }
    });
    try {
      await using provider = new NativeProvider({ modelBackend: model });
      const lookup = tool({
        name: 'lookup',
        description: 'Return a synthetic value.',
        parameters: z.object({}),
        allowedCallers: ['programmatic'],
        execute: async () => {
          effects.push('selected');
          return 'ok';
        },
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use the selected tool.',
        tools: [lookup, hostedTool({ type: 'programmatic_tool_calling' })],
      });
      const outcome = await agent.run('Use lookup.', {
        returnItems: true,
        signal: AbortSignal.timeout(6000),
      });
      expect(outcome.finalOutput).toBe('done');
      expect(effects).toEqual(
        mode === 'continued-progress' ? ['selected', 'selected'] : ['selected'],
      );
      expect(frames.map((frame) => frame.type)).toEqual([
        'response.create',
        'response.inject',
        ...(mode === 'continued-progress' ? ['response.inject'] : []),
      ]);
      expect(outcome.runUsage.requests).toBe(1);
      expect(
        outcome.items
          ?.filter((entry) => entry.item.type === 'program_output')
          .map((entry) => entry.item.status),
      ).toEqual(
        mode === 'ordinary'
          ? ['completed']
          : mode === 'terminal-identical'
            ? ['incomplete', 'incomplete', 'completed']
            : ['incomplete', 'completed'],
      );
      expect(
        projected
          .filter(
            (part) =>
              part.type === 'response.output_item.done' &&
              part.item?.type === 'program_output',
          )
          .map((part) => part.item.status),
      ).toEqual(
        mode === 'ordinary'
          ? ['completed']
          : mode === 'repeated-incomplete' || mode === 'terminal-identical'
            ? ['incomplete', 'incomplete', 'completed']
            : ['incomplete', 'completed'],
      );
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
