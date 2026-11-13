import { EventEmitter } from 'node:events';
import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  ResponsesWebSocketModel,
  type ResponsesSocket,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { markResponsesSocketFrame } from '../../src/runtime/responses-websocket-model';

it.each([false, true])(
  'keeps original WebSocket events separate from local frames with raw=%s',
  async (capture) => {
    const genuine = {
      type: 'response.inject.created',
      response_id: 'resp_wire',
      fixture: { values: [false, null, 0] },
    };
    const finished = {
      type: 'response.completed',
      response: {
        id: 'resp_wire',
        status: 'completed',
        output: [
          {
            id: 'msg_wire',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Answer.' }],
          },
        ],
      },
    };
    const model = new ResponsesWebSocketModel(() => {
      const socket = Object.assign(new EventEmitter(), { readyState: 1 });
      type Envelope = Parameters<typeof markResponsesSocketFrame>[0];
      const envelope = (message: JsonObject) =>
        ({ type: 'message', message }) as unknown as Envelope;
      return {
        socket,
        send() {
          /* The model fixture has no outgoing effect. */
        },
        close() {
          socket.readyState = 3;
          socket.emit('close');
        },
        async *[Symbol.asyncIterator]() {
          yield markResponsesSocketFrame(envelope(genuine), 'raw');
          yield markResponsesSocketFrame(
            envelope({
              type: 'response.output_item.done',
              output_index: 0,
              item: finished.response.output[0],
            }),
            'projected',
          );
          yield markResponsesSocketFrame(envelope(finished), 'projected');
        },
      } as unknown as ResponsesSocket;
    });
    await using provider = new NativeProvider({ modelBackend: model });
    await using session = await new Agent({
      provider,
      model: 'fixture',
      instructions: 'Answer.',
    }).session({
      includeRawProviderEvents: capture,
      observationRetention: 'all',
    });
    const turn = await session.submit('Begin.');
    const events: unknown[] = [];
    for await (const event of turn.events({ includeExecutionDetails: true })) {
      if (event.type === 'raw_provider_event')
        events.push([event.source, event.transport, event.payload]);
    }
    expect((await turn.wait()).finalOutput).toBe('Answer.');
    expect(events).toEqual(
      capture ? [['responses', 'websocket', genuine]] : [],
    );
  },
);
