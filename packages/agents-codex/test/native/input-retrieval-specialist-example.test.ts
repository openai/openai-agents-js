import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  OutputValidationError,
  tool,
  type ToolContext,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';
import {
  imageAgent,
  imageMessage,
  syntheticPng,
} from '../../../../examples/codex/input-retrieval-specialist/image-input';
import {
  answerQuestion,
  corpus,
} from '../../../../examples/codex/input-retrieval-specialist/retrieval';
import {
  consult,
  readCatalog,
  summarySchema,
  type Application,
  type Catalog,
  type Summary,
} from '../../../../examples/codex/input-retrieval-specialist/specialist-tool';

// Read the public wire snapshot, including Core's function namespace envelope.
function declarations(request: Record<string, unknown>): Record<string, any>[] {
  const tools = request.tools as Record<string, any>[] | undefined;
  if (tools) return tools;
  const additional = (request.input as Record<string, any>[]).find(
    (item) => item.type === 'additional_tools',
  );
  return (
    additional?.tools.find(
      (item: Record<string, any>) => item.name === 'functions',
    )?.tools ?? []
  );
}

describe('native input and composition recipes', () => {
  it('sends local PNG bytes with text and validates settled output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'image-recipe-test-'));
    try {
      const path = join(directory, 'red.png');
      await writeFile(path, syntheticPng);
      await withScriptedResponses(
        [[text('{"dominantColor":"red","confidence":1}')]],
        async (peer) => {
          expect(
            (await imageAgent(peer.provider).run(await imageMessage(path)))
              .finalOutput,
          ).toEqual({ dominantColor: 'red', confidence: 1 });
          const input = peer.requests[0].input as Record<string, any>[];
          const content = input.find(
            (item) =>
              item.role === 'user' &&
              item.content?.some(
                (part: Record<string, any>) => part.type === 'input_image',
              ),
          )!.content;
          expect(content[0]).toEqual({
            type: 'input_text',
            text: 'Name the dominant color in this synthetic image.',
          });
          expect(content).toHaveLength(2);
          expect(content[1].image_url.split(',')[0]).toBe(
            'data:image/png;base64',
          );
          expect(
            Buffer.from(content[1].image_url.split(',')[1], 'base64'),
          ).toEqual(syntheticPng);
          expect((peer.requests[0].text as any).format.type).toBe(
            'json_schema',
          );
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid settled image output', async () => {
    await withScriptedResponses(
      [[text('{"dominantColor":"red","confidence":9}')]],
      async (peer) => {
        await expect(
          imageAgent(peer.provider).run({
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: `data:image/png;base64,${syntheticPng.toString('base64')}`,
              },
            ],
          }),
        ).rejects.toBeInstanceOf(OutputValidationError);
        expect(peer.requests).toHaveLength(1);
      },
    );
  });

  it.each([
    'https://example.com/image.png',
    '/tmp/image.png',
    'file_synthetic',
  ])(
    'refuses unsupported image reference %s before a request',
    async (image_url) => {
      await withScriptedResponses([], async (peer) => {
        await expect(
          imageAgent(peer.provider).run({
            role: 'user',
            content: [{ type: 'input_image', image_url }],
          }),
        ).rejects.toThrow('base64 image data URL');
        expect(peer.requests).toEqual([]);
      });
    },
  );

  it('uses only actual scoped passages and exposes query alone', async () => {
    await withScriptedResponses(
      [
        [toolCall('search', { query: 'opens' }, { callId: 'search' })],
        [
          text(
            '{"answer":"09:00 on weekdays","sourceIds":["acme-hours"],"found":true}',
          ),
        ],
      ],
      async (peer) => {
        const result = await answerQuestion(
          'When does the library open?',
          'acme',
          corpus,
          peer.provider,
        );
        expect(result.answer.answer).toBe('09:00 on weekdays');
        expect(result.retrieved).toEqual({ 'acme-hours': corpus[0].passage });
        expect(JSON.parse(peer.toolOutput('search')!)).toEqual([
          { sourceId: 'acme-hours', passage: corpus[0].passage },
        ]);
        expect(
          Object.keys(
            declarations(peer.requests[0]).find(
              (entry) => entry.name === 'search',
            )!.parameters.properties,
          ),
        ).toEqual(['query']);
      },
    );
  });

  it.each(['cafeteria', 'access'])(
    'keeps absent/foreign query %s unavailable',
    async (query) => {
      await withScriptedResponses(
        [
          [toolCall('search', { query }, { callId: 'search' })],
          [text('{"answer":"Unavailable","sourceIds":[],"found":false}')],
        ],
        async (peer) => {
          expect(
            await answerQuestion(query, 'acme', corpus, peer.provider),
          ).toEqual({
            answer: { answer: 'Unavailable', sourceIds: [], found: false },
            retrieved: {},
          });
          expect(JSON.parse(peer.toolOutput('search')!)).toEqual([]);
          expect(JSON.stringify(peer.requests)).not.toContain('SYNTHETIC-42');
        },
      );
    },
  );

  it.each([
    [['other-code'], true],
    [[], true],
    [['acme-hours'], false],
  ] as const)(
    'rejects invalid citations %j / found=%s',
    async (sourceIds, found) => {
      await withScriptedResponses(
        [
          [toolCall('search', { query: 'opens' }, { callId: 'search' })],
          [text(JSON.stringify({ answer: 'Unsupported', sourceIds, found }))],
        ],
        async (peer) => {
          await expect(
            answerQuestion('When?', 'acme', corpus, peer.provider),
          ).rejects.toThrow(/source|Found/);
        },
      );
    },
  );

  it('bounds search results and creates a fresh citation set per run', async () => {
    const passages = [0, 1, 2].map((n) => ({
      tenant: 'acme',
      sourceId: `source-${n}`,
      passage: 'needle ' + 'x'.repeat(300),
    }));
    await withScriptedResponses(
      [
        [toolCall('search', { query: 'needle' }, { callId: 'bounded' })],
        [text('{"answer":"Found","sourceIds":["source-0"],"found":true}')],
        [text('{"answer":"Stale","sourceIds":["source-0"],"found":true}')],
      ],
      async (peer) => {
        await answerQuestion('Find needle', 'acme', passages, peer.provider);
        const matches = JSON.parse(peer.toolOutput('bounded')!);
        expect(matches).toHaveLength(2);
        expect(
          matches.map((entry: { passage: string }) => entry.passage.length),
        ).toEqual([240, 240]);
        await expect(
          answerQuestion('Again', 'acme', passages, peer.provider),
        ).rejects.toThrow('not retrieved in this run');
      },
    );
  });

  it('keeps specialist tools/context explicit and returns validated summary', async () => {
    await withScriptedResponses(
      [
        [
          toolCall(
            'consult',
            { question: 'Read title.' },
            { callId: 'consult' },
          ),
        ],
        [text('Done.')],
      ],
      (outer) =>
        withScriptedResponses(
          [
            [toolCall('read_catalog', {}, { callId: 'catalog' })],
            [text('{"title":"Synthetic catalog"}')],
          ],
          async (inner) => {
            const specialist = new Agent<Catalog, Summary>({
              instructions: 'Read.',
              tools: [readCatalog],
              outputType: summarySchema,
              provider: inner.provider,
            });
            await new Agent<Application>({
              instructions: 'Consult the specialist.',
              tools: [consult],
              provider: outer.provider,
            }).run('Consult.', {
              context: { specialist, catalog: { title: 'Synthetic catalog' } },
            });
            expect(inner.toolOutput('catalog')).toBe('Synthetic catalog');
            expect(JSON.parse(outer.toolOutput('consult')!)).toEqual({
              title: 'Synthetic catalog',
            });
            expect(
              declarations(inner.requests[0]).map((entry) => entry.name),
            ).toEqual(['read_catalog']);
            expect(
              declarations(outer.requests[0]).map((entry) => entry.name),
            ).toEqual(['consult']);
          },
        ),
    );
  });
});

it.each([false, true])(
  'joins specialist cleanup on cancellation/failure=%s and preserves other owners',
  async (failure) => {
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let cleaned = false;
    const nested = tool({
      name: 'nested',
      description: 'Read the supplied catalog with controlled cleanup.',
      parameters: z.strictObject({}),
      execute: async (_args, { context, signal }: ToolContext<Catalog>) => {
        expect(context).toEqual({ title: 'limited' });
        entered.resolve();
        try {
          if (failure) throw new Error('Specialist failed');
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        } finally {
          cleaning.resolve();
          if (!failure) await release.promise;
          cleaned = true;
        }
        return 'unreachable';
      },
    });
    await withScriptedResponses(
      [
        [toolCall('consult', { question: 'Read.' }, { callId: 'outer' })],
        [text('Continued.')],
      ],
      (outer) =>
        withScriptedResponses(
          [
            [toolCall('nested', {}, { callId: 'inner' })],
            [text('{"title":"Other owner"}')],
          ],
          async (inner) => {
            const specialist = new Agent<Catalog, Summary>({
              instructions: 'Read the catalog.',
              tools: [nested],
              outputType: summarySchema,
              provider: inner.provider,
            });
            await using other = await specialist.session({
              context: { title: 'other' },
            });
            const parent = new Agent<Application>({
              instructions: 'Consult the specialist.',
              tools: [consult],
              provider: outer.provider,
            });
            await using session = await parent.session({
              context: { specialist, catalog: { title: 'limited' } },
            });
            const turn = await session.submit('Consult.');
            const outcome = turn.wait().then(
              () => undefined,
              (error: unknown) => error,
            );
            await entered.promise;
            if (failure) {
              expect(await outcome).toBeInstanceOf(Error);
            } else {
              let stopped = false;
              const stopping = turn.cancel().then(() => {
                stopped = true;
              });
              await cleaning.promise;
              try {
                expect(stopped).toBe(false);
                expect(cleaned).toBe(false);
              } finally {
                release.resolve();
              }
              await stopping;
              expect(await outcome).toBeInstanceOf(Error);
            }
            expect(cleaned).toBe(true);
            expect(outer.toolOutput('outer')).toBeUndefined();
            expect(inner.toolOutput('inner')).toBeUndefined();
            expect(
              (await (await session.submit('Continue.')).wait()).finalOutput,
            ).toBe('Continued.');
            expect(
              (await (await other.submit('Read independently.')).wait())
                .finalOutput,
            ).toEqual({ title: 'Other owner' });
          },
        ),
    );
  },
  30_000,
);
