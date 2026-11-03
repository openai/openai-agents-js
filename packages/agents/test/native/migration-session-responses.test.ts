import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  Runner,
  withTrace,
  setTracingDisabled,
  tool,
} from '@openai/agents-core';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);

describe('Responses HTTP completed Session on the native adapter', () => {
  it('imports classic Responses text, stores one native effect and continues without replay', async () => {
    const text = (
      id: string,
      value: string,
    ): OpenAI.Responses.ResponseOutputMessage => ({
      id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: value, annotations: [] }],
    });
    const outputs: OpenAI.Responses.ResponseOutputItem[][] = [
      [text('msg_classic', 'classic complete')],
      [
        {
          id: 'fc_effect',
          type: 'function_call',
          call_id: 'call_effect',
          name: 'effect',
          arguments: '{"value":"once"}',
          status: 'completed',
        },
      ],
      [text('msg_complete', 'effect complete')],
      [text('msg_continue', 'continued without replay')],
    ];
    const requests: {
      method?: string;
      url?: string;
      body: OpenAI.Responses.ResponseCreateParamsNonStreaming;
    }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      const output = outputs[requests.length - 1];
      if (
        request.method !== 'POST' ||
        request.url !== '/v1/responses' ||
        !output
      ) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: 'Unexpected fixture request' } }),
        );
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `resp_${requests.length}`,
          object: 'response',
          created_at: 1,
          status: 'completed',
          error: null,
          incomplete_details: null,
          model: 'fixture-responses',
          output,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing fixture address');
      const client = new OpenAI({
        apiKey: 'synthetic-local-fixture-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        maxRetries: 0,
      });
      const effects: string[] = [];
      const effect = tool({
        name: 'effect',
        description: 'Record one effect',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          effects.push(value);
          return value;
        },
      });
      const store = new MemorySession();
      const model = new OpenAIResponsesModel(client, 'fixture-responses');
      // Observe the real converter; this spy does not replace Model execution.
      const responses = vi.spyOn(model, 'getResponse');
      const classic = await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: 'classic HTTP Session', model }),
        'classic input',
        { session: store },
      );
      expect(classic.finalOutput).toBe('classic complete');
      const imported = await store.getItems();
      expect(imported).toHaveLength(2);
      expect(imported[1]).toMatchObject({
        id: 'msg_classic',
        status: 'completed',
        providerData: {},
        content: [
          {
            type: 'output_text',
            text: 'classic complete',
            providerData: { annotations: [] },
          },
        ],
      });
      const originalImported = structuredClone(imported);
      const result = await withTrace('local Responses Session', () =>
        SDKRunner.run(
          new Agent({
            name: 'HTTP Session',
            instructions: 'Use the tool.',
            model,
            tools: [effect],
          }),
          'apply once',
          { context: {}, session: store },
        ),
      );
      expect(effects).toEqual(['once']);
      expect(result.finalOutput).toBe('effect complete');
      expect(requests).toHaveLength(3);
      expect(requests[2].body.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            call_id: 'call_effect',
          }),
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'call_effect',
            output: 'once',
          }),
        ]),
      );
      const converted = await responses.mock.results[2].value;
      expect(converted.output[0]).toMatchObject({
        type: 'message',
        providerData: {},
        content: [
          {
            type: 'output_text',
            text: 'effect complete',
            providerData: { annotations: [] },
          },
        ],
      });
      const retained = await store.getItems();
      expect(retained.slice(0, 2)).toEqual(originalImported);
      expect(retained).toEqual(result.toInputList());
      expect(result.newItems[2].rawItem).toEqual(converted.output[0]);
      expect(retained.map((item) => item.type)).toEqual([
        'message',
        'message',
        'message',
        'function_call',
        'function_call_result',
        'message',
      ]);
      expect(retained[3]).toMatchObject({
        callId: 'call_effect',
        name: 'effect',
        arguments: '{"value":"once"}',
      });
      expect(retained[4]).toMatchObject({
        callId: 'call_effect',
        name: 'effect',
        output: 'once',
      });

      const continued = await withTrace('fresh local Responses Session', () =>
        SDKRunner.run(
          new Agent({
            name: 'fresh HTTP Session',
            instructions: 'Continue without repeating effects.',
            model: new OpenAIResponsesModel(client, 'fixture-responses'),
            tools: [effect],
          }),
          'continue',
          { context: {}, session: store },
        ),
      );
      expect(continued.finalOutput).toBe('continued without replay');
      expect(effects).toEqual(['once']);
      expect(requests).toHaveLength(4);
      expect(requests[3].body.input).toEqual([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ type: 'message', id: 'msg_classic' }),
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({
          type: 'function_call',
          call_id: 'call_effect',
          name: 'effect',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_effect',
          output: 'once',
        }),
        expect.objectContaining({
          type: 'message',
          id: 'msg_complete',
          content: [
            { type: 'output_text', text: 'effect complete', annotations: [] },
          ],
        }),
        expect.objectContaining({ role: 'user' }),
      ]);
      const stored = await store.getItems();
      expect(stored.slice(0, retained.length)).toEqual(retained);
      expect(stored).toEqual(continued.toInputList());
      expect(stored).toHaveLength(8);
      expect(imported).toEqual(originalImported);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
