import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NativeProviderOptions } from '@openai/agents';
import {
  publishArtifact,
  runValidatedArtifact,
  type ArtifactContext,
} from '../../examples/validated-artifact';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const sentinel = 'Existing application artifact.\n';
const validJson = '{"slides":[{"text":"Use plain language."}]}';
const expectedFile =
  '{\n  "slides": [\n    {\n      "text": "Use plain language."\n    }\n  ]\n}\n';
let directory: string;
let context: ArtifactContext;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'validated-artifact-test-'));
  context = {
    tenantId: 'application-tenant',
    memory: { readNote: async () => 'Use plain language.' },
    outputPath: join(directory, 'presentation.json'),
  };
  await writeFile(context.outputPath, sentinel, 'utf8');
});
afterEach(async () => {
  await ModelServer.closeAll();
  await rm(directory, { recursive: true, force: true });
});

describe('validate before publishing an application artifact', () => {
  it.each([
    ['malformed JSON', '{'],
    ['an empty presentation', '{"slides":[]}'],
    [
      'a model-selected destination',
      '{"slides":[{"text":"Valid slide"}],"outputPath":"other.json"}',
    ],
  ])(
    'returns a correction for %s without changing the existing file',
    async (_label, json) => {
      const result = await publishArtifact(context, json);
      expect(result.success).toBe(false);
      expect(result.contentItems).toEqual([
        {
          type: 'inputText',
          text: expect.stringContaining('call publish_json again'),
        },
      ]);
      expect(await readFile(context.outputPath, 'utf8')).toBe(sentinel);
    },
  );

  it('writes validated JSON to the application-selected path', async () => {
    const otherPath = join(directory, 'other.json');
    await writeFile(otherPath, 'Unselected file.', 'utf8');
    const result = await publishArtifact(context, validJson);
    expect(result.success).toBe(true);
    expect(result.contentItems).toEqual([
      {
        type: 'inputText',
        text: 'Published validated JSON: presentation.json',
      },
    ]);
    expect(await readFile(context.outputPath, 'utf8')).toBe(expectedFile);
    expect(await readFile(otherPath, 'utf8')).toBe('Unselected file.');
  });

  it('rejects an unexpected filesystem failure instead of asking for a correction', async () => {
    await expect(
      publishArtifact({ ...context, outputPath: directory }, validJson),
    ).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await readFile(context.outputPath, 'utf8')).toBe(sentinel);
  });
});

async function providerOptions(
  server: ModelServer,
): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-artifact-key',
    supportsWebsockets: false,
  };
}

function declarations(request: JsonObject): JsonObject[] {
  if (Array.isArray(request.tools)) return request.tools as JsonObject[];
  const item = (request.input as JsonObject[]).find(
    (entry) => entry.type === 'additional_tools',
  );
  return (item?.tools as JsonObject[] | undefined)?.find(
    (namespace) => namespace.name === 'functions',
  )?.tools as JsonObject[];
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'artifact correction through the native tool loop',
  () => {
    it('delivers the failed result before accepting a repaired artifact', async () => {
      const entered = Promise.withResolvers<void>();
      const note = Promise.withResolvers<string>();
      const memoryCalls: string[][] = [];
      context = {
        ...context,
        memory: {
          async readNote(tenantId, key) {
            memoryCalls.push([tenantId, key]);
            entered.resolve();
            return note.promise;
          },
        },
      };
      const server = new ModelServer([
        [call('read_memory', { key: 'audience' }, { callId: 'memory' })],
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'Use plain language.',
          );
          return [
            call('publish_json', { json: '{' }, { callId: 'invalid-artifact' }),
          ];
        },
        async (request) => {
          const rejected = (request.input as JsonObject[]).find(
            (item) =>
              item.type === 'function_call_output' &&
              item.call_id === 'invalid-artifact',
          );
          expect(rejected).toBeDefined();
          expect(JSON.stringify(rejected!.output)).toContain(
            'JSON is not well formed. Fix it and call publish_json again.',
          );
          expect(await readFile(context.outputPath, 'utf8')).toBe(sentinel);
          return [
            call(
              'publish_json',
              { json: validJson },
              { callId: 'repaired-artifact' },
            ),
          ];
        },
        async (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'Published validated JSON: presentation.json',
          );
          expect(await readFile(context.outputPath, 'utf8')).toBe(expectedFile);
          return [message('Published one validated slide.')];
        },
      ]);
      const options = await providerOptions(server);
      const running = runValidatedArtifact(context, options);
      try {
        await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error('Run ended before reading memory');
          }),
        ]);
        expect(server.requests).toHaveLength(1);
        expect(await readFile(context.outputPath, 'utf8')).toBe(sentinel);
        note.resolve('Use plain language.');
        await expect(running).resolves.toBe('Published one validated slide.');
        expect(memoryCalls).toEqual([['application-tenant', 'audience']]);
        const publish = declarations(server.requests[0]).find(
          (entry) => entry.name === 'publish_json',
        );
        expect(publish).toBeDefined();
        expect(publish!.parameters).toMatchObject({
          properties: { json: { type: 'string' } },
          required: ['json'],
          additionalProperties: false,
        });
        expect(
          Object.keys(
            (publish!.parameters as JsonObject).properties as JsonObject,
          ),
        ).toEqual(['json']);
        const requests = JSON.stringify(server.requests);
        for (const privateValue of [
          context.tenantId,
          context.outputPath,
          'tenantId',
          'outputPath',
          options.apiKey!,
        ])
          expect(requests).not.toContain(privateValue);
        expect(await readFile(context.outputPath, 'utf8')).toBe(expectedFile);
        server.assertExhausted();
      } finally {
        note.resolve('Use plain language.');
        await running.catch(() => {});
      }
    }, 25000);

    it('ends on an unexpected I/O failure without another model request', async () => {
      const server = new ModelServer([
        [call('publish_json', { json: validJson }, { callId: 'io-failure' })],
      ]);
      await expect(
        runValidatedArtifact(
          { ...context, outputPath: directory },
          await providerOptions(server),
        ),
      ).rejects.toMatchObject({ code: 'EISDIR' });
      expect(await readFile(context.outputPath, 'utf8')).toBe(sentinel);
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    }, 25000);
  },
);
