import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { _ContextChange } from '../../native/index.js';
import { Agent, NativeProvider, StdioMCP, type Session } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

const PEER = String.raw`
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [phase, trace, mode] = process.argv.slice(2);
// Snapshot at launch: changing the phase cannot turn the surviving source peer
// into a question producer during later source operations.
const candidate = readFileSync(phase, 'utf8') === 'candidate';
const record = (event) => appendFileSync(trace,
  JSON.stringify({ event, candidate, pid: process.pid }) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let asked = false;
record('started');
process.on('exit', () => record('exited'));
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method) {
    record(request.jsonrpc === '2.0' && request.id === 'startup-form' &&
      request.result?.action === 'cancel' &&
      !Object.hasOwn(request.result, 'content') && request.error === undefined
      ? 'form-cancelled' : 'unexpected-response');
    continue;
  }
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'startup', version: '1' } };
  } else if (request.method === 'tools/list') {
    if (candidate && mode === 'question' && !asked) {
      asked = true;
      record('form-sent');
      send({ jsonrpc: '2.0', id: 'startup-form', method: 'elicitation/create',
        params: { mode: 'form', message: 'Choose the startup answer.',
          requestedSchema: { type: 'object', properties: { answer: { type: 'string' } },
            required: ['answer'] } } });
    }
    // Listing remains independent of the client's startup-form cancellation.
    result = { tools: [{ name: 'lookup', description: 'Read a synthetic record',
      annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } }] };
    record('list-replied');
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: 'synthetic record' }] };
  } else if (request.method === 'ping') {
    result = {};
  } else {
    send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } });
    continue;
  }
  send({ jsonrpc: '2.0', id: request.id, result });
}
`;

async function values<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of source) result.push(value);
  return result;
}

async function trace(
  path: string,
): Promise<{ event: string; candidate: boolean; pid: number }[]> {
  const text = await readFile(path, 'utf8');
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it.each(['plain', 'question', 'publication failure'] as const)(
  'uses retained compaction with candidate startup mode %s',
  async (mode) => {
    const question = mode === 'question';
    const originalInput = 'Record original conversation.';
    const summary = 'The original conversation is retained.';
    const directory = await mkdtemp(
      join(tmpdir(), 'public-compaction-startup-'),
    );
    const phase = join(directory, 'phase');
    const log = join(directory, 'peers.jsonl');
    const peer = join(directory, 'peer.mjs');
    await Promise.all([
      writeFile(phase, 'source'),
      writeFile(log, ''),
      writeFile(peer, PEER),
    ]);
    const model = new ModelServer([
      [message('original')],
      (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain(originalInput);
        if (mode === 'publication failure') {
          expect(input).toContain('"text":"original"');
          expect(input).not.toContain(summary);
        } else {
          expect(input).toContain(summary);
          expect(input).not.toContain('"text":"original"');
        }
        return [message('continued')];
      },
    ]);
    let provider: NativeProvider | undefined;
    let session: Session | undefined;
    let retainedCandidates: number[] = [];
    try {
      const config = await model.config();
      provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-public-startup',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use the synthetic conversation.',
        model: 'gpt-5',
        provider,
        programmaticToolCalling: false,
        tools: [
          new StdioMCP({
            name: 'startup',
            tools: ['lookup'],
            approvalMode: 'approve',
            command: process.execPath,
            args: [peer, phase, log, question ? 'question' : 'control'],
            cwd: directory,
          }),
        ],
      });
      session = await agent.session();
      const original = await session.submit(originalInput);
      const completed = await original.wait();
      const id = session.id;
      const items = await values(session.items());
      const turns = await values(session.turns());
      expect(completed.finalOutput).toBe('original');
      expect(model.requests).toHaveLength(1);
      expect(
        (await trace(log)).some(
          (record) => !record.candidate && record.event === 'list-replied',
        ),
      ).toBe(true);
      const snapshot = await session.modelContext();
      const user = snapshot.items.findIndex((item) =>
        JSON.stringify(item).includes(originalInput),
      );
      expect(user).toBeGreaterThanOrEqual(0);
      await writeFile(phase, 'candidate');

      const options = { summary, snapshot, retain: [user] };
      if (mode === 'publication failure') {
        const addon = await binding();
        const publish =
          addon._ContextChange.prototype.publishCandidateMcpServers;
        const failure = new Error('Candidate publication did not complete');
        vi.spyOn(
          addon._ContextChange.prototype,
          'publishCandidateMcpServers',
        ).mockImplementationOnce(async function (
          this: _ContextChange,
          ...args
        ) {
          await publish.call(this, ...args);
          throw failure;
        });
        await expect(session.compact(options)).rejects.toBe(failure);
        expect(await session.modelContext()).toEqual(snapshot);
        const peers = await trace(log);
        const candidates = peers.filter(
          (record) => record.candidate && record.event === 'started',
        );
        expect(candidates.length).toBeGreaterThan(0);
        await vi.waitFor(
          () => {
            for (const { pid } of candidates) expect(alive(pid)).toBe(false);
          },
          { timeout: 8000 },
        );
      } else if (question) {
        await expect(session.compact(options)).resolves.toBeUndefined();
        await vi.waitFor(async () => {
          const emitted = (await trace(log)).filter(
            (record) => record.candidate,
          );
          const forms = emitted.filter(
            (record) => record.event === 'form-sent',
          );
          expect(forms.length).toBeGreaterThan(0);
          expect(
            emitted.filter((record) => record.event === 'form-cancelled'),
          ).toHaveLength(forms.length);
          expect(
            emitted.some((record) => record.event === 'list-replied'),
          ).toBe(true);
          expect(
            emitted.some((record) => record.event === 'unexpected-response'),
          ).toBe(false);
        });
        expect(await session.pendingInteractions()).toEqual([]);
        const peers = await trace(log);
        const sources = peers.filter(
          (record) => !record.candidate && record.event === 'started',
        );
        expect(sources.length).toBeGreaterThan(0);
        await vi.waitFor(
          () => {
            for (const { pid } of sources) expect(alive(pid)).toBe(false);
          },
          { timeout: 8000 },
        );
        retainedCandidates = peers
          .filter(
            (record) =>
              record.candidate &&
              record.event === 'started' &&
              alive(record.pid),
          )
          .map((record) => record.pid);
        expect(retainedCandidates.length).toBeGreaterThan(0);
        expect(await values(session.items())).toEqual(items);
        expect(await values(session.turns())).toEqual(turns);
        expect(await original.wait()).toBe(completed);
      } else {
        await session.compact(options);
        expect(
          (await trace(log)).some(
            (record) => record.candidate && record.event === 'list-replied',
          ),
        ).toBe(true);
      }
      expect(session.id).toBe(id);
      expect(model.requests).toHaveLength(1);
      expect(
        (await (await session.submit('Continue the conversation.')).wait())
          .finalOutput,
      ).toBe('continued');
      expect(model.requests).toHaveLength(2);
      model.assertExhausted();
      if (question) {
        for (const pid of retainedCandidates) expect(alive(pid)).toBe(true);
        expect(await session.pendingInteractions()).toEqual([]);
        expect(
          (await trace(log)).some(
            (record) => record.event === 'unexpected-response',
          ),
        ).toBe(false);
      }
    } finally {
      vi.restoreAllMocks();
      await session?.close();
      await provider?.close();
      await ModelServer.closeAll();
      const started = (await trace(log)).filter(
        (record) => record.event === 'started',
      );
      await vi.waitFor(
        () => {
          for (const { pid } of started) expect(alive(pid)).toBe(false);
        },
        { timeout: 8000 },
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
