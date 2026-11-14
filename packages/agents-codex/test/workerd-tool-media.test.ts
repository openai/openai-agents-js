import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  runWorkerText,
  standaloneTool,
  ToolOutput,
} from '../src/runtime/workerd';
import { toolMediaFixture } from './fixtures/worker-tool-media';

const asset = new URL('../native/codex-turn-control.wasm', import.meta.url);
it.skipIf(!existsSync(asset))(
  'retains tool media through physical HTTP, partial approval and cold restore',
  async () => {
    const requests: any[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const continued = body.input.some(
        (item: any) => item.type === 'function_call_output',
      );
      const output = continued
        ? [
            {
              type: 'message',
              role: 'assistant',
              id: 'answer',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ]
        : [
            {
              type: 'function_call',
              name: 'media',
              call_id: 'media-1',
              arguments: '{}',
            },
            {
              type: 'function_call',
              name: 'approval',
              call_id: 'approval-1',
              arguments: '{}',
            },
          ];
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'fixture-' + requests.length,
          object: 'response',
          status: 'completed',
          model: 'fixture',
          output,
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Fixture address');
    try {
      const control = new WebAssembly.Module(await readFile(asset));
      const result = await toolMediaFixture(
        () => control,
        new OpenAI({
          apiKey: 'fixture',
          baseURL: 'http://127.0.0.1:' + address.port + '/v1',
          maxRetries: 0,
        }),
      );
      expect(result.mediaCalls).toBe(1);
      expect(result.approvalCalls).toBe(1);
      expect(requests).toHaveLength(3);
      const expected = [
        { type: 'input_text', text: 'local media' },
        { type: 'input_image', file_id: 'image-id', detail: 'low' },
        { type: 'input_file', file_id: 'file-id' },
        {
          type: 'input_image',
          image_url:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+4eQAAAAASUVORK5CYII=',
        },
        {
          type: 'input_file',
          file_data: 'data:application/pdf;base64,JVBERi0xLjc=',
          filename: 'sample.pdf',
        },
        {
          type: 'input_file',
          file_url: 'https://example.com/signed.pdf?token=one',
        },
      ];
      expect(result.partialSnapshot.approval.results[0][1]).toEqual(expected);
      for (const body of requests.slice(1))
        expect(
          body.input.find(
            (item: any) =>
              item.type === 'function_call_output' &&
              item.call_id === 'media-1',
          ).output,
        ).toEqual(expected);
      expect(JSON.stringify(requests)).not.toContain('forged');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.skipIf(!existsSync(asset))(
  'preserves string after-guards and refuses a media finishing result before commit',
  async () => {
    const control = new WebAssembly.Module(await readFile(asset));
    let calls = 0,
      guardView: any;
    const provider = {
      complete() {
        return {
          output:
            ++calls === 1
              ? [
                  {
                    type: 'function_call',
                    name: 'text',
                    call_id: 'text-1',
                    arguments: '{}',
                  },
                ]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'done' }],
                  },
                ],
        };
      },
    };
    await runWorkerText('text', {
      control,
      provider,
      model: 'fixture',
      instructions: '',
      tools: [
        standaloneTool({
          name: 'text',
          parameters: z.object({}),
          execute() {
            return 'plain';
          },
        }),
      ],
      toolGuardrails: {
        text: [
          {
            name: 'same string',
            after(view) {
              guardView = view;
              return { action: 'allow' };
            },
          },
        ],
      },
    });
    expect(guardView.output).toBe('plain');
    expect(guardView).not.toHaveProperty('response');
    let commits = 0;
    await expect(
      runWorkerText('finish', {
        control,
        model: 'fixture',
        instructions: '',
        provider: {
          complete() {
            return {
              output: [
                {
                  type: 'function_call',
                  name: 'finish',
                  call_id: 'finish-1',
                  arguments: '{}',
                },
              ],
            };
          },
        },
        tools: [
          standaloneTool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute() {
              return ToolOutput.image({ fileId: 'image-id' });
            },
          }),
        ],
        session: {
          id: 'finishing',
          store: {
            async acquire() {
              return 'lease';
            },
            async read() {
              return null;
            },
            async commit() {
              commits++;
            },
            async release() {},
          },
        },
      }),
    ).rejects.toThrow('Portable finishing tools require text output');
    expect(commits).toBe(0);
  },
);
