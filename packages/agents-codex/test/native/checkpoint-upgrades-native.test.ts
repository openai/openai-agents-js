import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  type SessionState,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const fixtures = new URL('./fixtures/checkpoint-upgrades/', import.meta.url);
const producer = new URL('fdd15e8a/', fixtures);
const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', producer), 'utf8'),
);
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function checkpoint(name: string): SessionState {
  const entry = manifest.cases.find(
    (entry: { file: string }) => entry.file === name + '.json',
  );
  const bytes = readFileSync(new URL(entry.file, producer));
  expect(digest(bytes)).toBe(entry.sha256);
  const state = parseSessionState(bytes.toString());
  expect(state.format_version).toBe(entry.sdk_format_version);
  expect(state.codex_revision).toBe(manifest.producer.codex_revision);
  return state;
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-checkpoint-consumer',
    supportsWebsockets: false,
  });
}

afterEach(async () => {
  await ModelServer.closeAll();
});

it('retains original capture bytes and producer identity', () => {
  expect(manifest.producer.kind).toBe('source-snapshot');
  expect(manifest.producer.source_commit).toBe(
    'fdd15e8abe181c64d3cbdff25b38f9c571af0a66',
  );
  expect(digest(readFileSync(new URL('capture.ts', fixtures)))).toBe(
    manifest.capture_script_sha256,
  );
  for (const name of ['idle', 'manual', 'code']) checkpoint(name);
});

it('rejects unknown envelope formats and foreign native revisions on every platform', () => {
  const raw = JSON.parse(readFileSync(new URL('idle.json', producer), 'utf8'));
  expect(() =>
    parseSessionState(JSON.stringify({ ...raw, format_version: 999 })),
  ).toThrow();
  expect(() =>
    parseSessionState(
      JSON.stringify({ ...raw, codex_revision: '0'.repeat(40) }),
    ),
  ).toThrow();
});

// The original Linux history requires compatible POSIX native paths.
const nativeTests = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1';
const posix = process.platform === 'linux' || process.platform === 'darwin';
describe.skipIf(!nativeTests || !posix)(
  'real older checkpoint producer',
  () => {
    it('continues original idle history without rewriting the supplied state', async () => {
      const state = checkpoint('idle');
      const original = JSON.stringify(state);
      const server = new ModelServer([[message('continued-after-upgrade')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Remember checkpoint history.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({ state });
      expect(session.id).toBe(state.source_session_id);
      expect(server.requests).toHaveLength(0);
      const result = await (await session.submit('idle-after-upgrade')).wait();
      expect(result.finalOutput).toBe('continued-after-upgrade');
      const retained = await session.saveState();
      expect(retained.history.slice(0, state.history.length)).toEqual(
        state.history,
      );
      const wire = JSON.stringify(server.requests[0]!.input);
      for (const text of [
        'idle-before-upgrade',
        'remembered-before-upgrade',
        'idle-after-upgrade',
      ])
        expect(wire.split(text)).toHaveLength(2);
      expect(JSON.stringify(state)).toBe(original);
      server.assertExhausted();
    }, 25000);

    it('resumes a fresh manual reply with accepted effects and output contract intact', async () => {
      const state = checkpoint('manual');
      const effects: string[] = [];
      const record = tool({
        name: 'record',
        description: 'Record.',
        parameters: z.object({ key: z.string() }),
        execute: ({ key }) => {
          effects.push(key);
          return 'recorded-' + key;
        },
      });
      const lookup = manualTool({
        name: 'lookup',
        description: 'Read',
        parameters: z.object({ key: z.string() }),
        result: z.string(),
      });
      const server = new ModelServer([[message('19')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Record and request a decision.',
        model: 'gpt-5.5',
        provider,
        tools: [record, lookup],
        outputType: { mode: 'prompted', schema: z.number().int() },
      });
      await using session = await agent.session({ state });
      expect(server.requests).toHaveLength(0);
      let replied = false;
      for await (const event of session.events()) {
        if (event.type !== 'action_requested') continue;
        expect(event.callId).toBe('pending-lookup');
        expect(event.arguments).toEqual({ key: 'pending' });
        expect(event.sessionId).toBe(session.id);
        const reply = event.reply('fresh-after-upgrade');
        await session.respond(reply);
        await expect(session.respond(reply)).rejects.toThrow();
        replied = true;
        break;
      }
      expect(replied).toBe(true);
      expect((await session.wait()).finalOutput).toBe(19);
      expect(effects).toEqual([]);
      const input = server.requests[0]!.input as {
        type: string;
        call_id?: string;
        output?: unknown;
      }[];
      for (const [id, output] of [
        ['accepted-record', 'recorded-accepted'],
        ['pending-lookup', 'fresh-after-upgrade'],
      ]) {
        expect(
          input.filter(
            (item) =>
              item.type === 'function_call_output' && item.call_id === id,
          ),
        ).toEqual([expect.objectContaining({ output })]);
      }
      server.assertExhausted();
    }, 25000);

    it('retains and reads the original native CodeMode stored value', async () => {
      const state = checkpoint('code');
      const server = new ModelServer([
        [
          {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'read-cell',
            input: 'text(load("retained").value);',
          },
        ],
        [message('read-after-upgrade')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Store and read checkpoint values.',
        model: 'gpt-5.5',
        provider,
        programmaticToolCalling: true,
      });
      await using session = await agent.session({ state });
      expect(server.requests).toHaveLength(0);
      expect((await session.saveState()).root_code_mode).toEqual(
        state.root_code_mode,
      );
      expect(
        (await (await session.submit('read-after-upgrade')).wait()).finalOutput,
      ).toBe('read-after-upgrade');
      const input = server.requests[1]!.input as {
        type: string;
        call_id?: string;
        output?: unknown;
      }[];
      const cellOutput = input.find(
        (item) =>
          item.type === 'custom_tool_call_output' &&
          item.call_id === 'read-cell',
      );
      expect(cellOutput).toBeDefined();
      expect(JSON.stringify(cellOutput!.output)).toContain('29');
      server.assertExhausted();
    }, 25000);

    it('keeps native output contract rejection', async () => {
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Record and request a decision.',
        model: 'gpt-5.5',
        provider,
        outputType: { mode: 'prompted', schema: z.string() },
      });
      await expect(
        agent.session({ state: checkpoint('manual') }),
      ).rejects.toThrow(/output/);
      server.assertExhausted();
    });
  },
);

it.skipIf(!nativeTests || process.platform !== 'win32')(
  'refuses original POSIX checkpoint history on Windows before model work',
  async () => {
    const state = checkpoint('idle');
    const original = JSON.stringify(state);
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Remember checkpoint history.',
      model: 'gpt-5.5',
      provider,
    });
    // Native history validation exposes its contextual error at this boundary.
    await expect(agent.session({ state })).rejects.toThrow(
      'Invalid checkpoint history record',
    );
    expect(server.requests).toHaveLength(0);
    expect(JSON.stringify(state)).toBe(original);
    server.assertExhausted();
  },
);
