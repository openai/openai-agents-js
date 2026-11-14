import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiSdkModel,
  runWorkerText,
  standaloneTool,
  type NativeModel,
} from '../src/runtime/workerd';
import type { AiSdkLanguageModel } from '../src/runtime/models';
import type { JsonObject } from '../src/runtime/binding';

const wasm = new URL('../native/codex-turn-control.wasm', import.meta.url);
const portableTest = it.skipIf(!existsSync(wasm));
let control: WebAssembly.Module;

beforeAll(async () => {
  if (!existsSync(wasm)) return;
  const bytes = await readFile(wasm);
  control = new WebAssembly.Module(bytes);
});

function lookup() {
  const execute = vi.fn(({ value }: { value: string }) => 'observed:' + value);
  return {
    execute,
    declaration: standaloneTool({
      name: 'lookup',
      description: 'Read a local value.',
      parameters: z.object({ value: z.string() }),
      execute,
    }),
  };
}

const input = '{"value":"local"}';
const call = {
  type: 'function_call',
  name: 'lookup',
  arguments: input,
  call_id: 'test-call',
};

portableTest(
  'returns one isolate-local result to the native AI SDK adapter',
  async () => {
    const tool = lookup();
    let requests = 0;
    const model = new AiSdkModel({
      specificationVersion: 'v3',
      provider: 'fixture',
      modelId: 'fixture',
      async doGenerate(options: { prompt: unknown }) {
        requests++;
        if (requests === 2)
          expect(JSON.stringify(options.prompt)).toContain('observed:local');
        return {
          content:
            requests === 1
              ? [
                  {
                    type: 'tool-call',
                    toolCallId: call.call_id,
                    toolName: call.name,
                    input,
                  },
                ]
              : [{ type: 'text', text: 'done' }],
          finishReason: { unified: requests === 1 ? 'tool-calls' : 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
    } as AiSdkLanguageModel);
    const text = await runWorkerText('Find the value.', {
      control,
      model: 'fixture',
      instructions: 'Use lookup.',
      tools: [tool.declaration],
      provider: model,
    });
    expect(text).toBe('done');
    expect(requests).toBe(2);
    expect(tool.execute).toHaveBeenCalledExactlyOnceWith(
      { value: 'local' },
      expect.any(Object),
    );
  },
);

portableTest(
  'never dispatches a program-owned call or a result that arrives after cancellation',
  async () => {
    const tool = lookup();
    const cleanup = vi.fn();
    const stop = new AbortController();
    const base = {
      control,
      model: 'fixture',
      instructions: 'Use lookup.',
      tools: [tool.declaration],
    };
    const program = {
      ...call,
      caller: { type: 'program', caller_id: 'not-admitted' },
    };
    await expect(
      runWorkerText('Find the value.', {
        ...base,
        provider: {
          complete: () => ({ output: [program] }),
          cleanupOnRunEnd: cleanup,
        } satisfies NativeModel,
      }),
    ).rejects.toThrow('unsupported portable function call');
    const cancelled = new Error('cancelled');
    await expect(
      runWorkerText('Find the value.', {
        ...base,
        signal: stop.signal,
        provider: {
          complete: () => {
            stop.abort(cancelled);
            return { output: [call] };
          },
          cleanupOnRunEnd: cleanup,
        },
      }),
    ).rejects.toBe(cancelled);
    expect(tool.execute).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(2);
  },
);

portableTest(
  'observes live stream events and waits for a complete stream before dispatch',
  async () => {
    const tool = lookup();
    const order: string[] = [];
    const completed = (id: string, output: JsonObject[]) => ({
      type: 'response.completed',
      response: { id, status: 'completed', output },
    });
    let requests = 0;
    const provider: NativeModel = {
      complete() {
        throw new Error('Expected the stream adapter');
      },
      async *stream({ body }) {
        requests++;
        if (requests === 1) {
          yield { type: 'response.output_text.delta', delta: 'working' };
          expect(order).toContain('response.output_text.delta');
          yield completed('one', [call]);
          expect(tool.execute).not.toHaveBeenCalled();
          order.push('first stream closed');
        } else {
          expect(order).toContain('first stream closed');
          expect(JSON.stringify(body.input)).toContain('observed:local');
          yield completed('two', [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ]);
        }
      },
    };
    await expect(
      runWorkerText('Find the value.', {
        control,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool.declaration],
        provider,
        observe(event) {
          order.push(String(event.type));
        },
      }),
    ).resolves.toBe('done');
    expect(requests).toBe(2);
    expect(tool.execute).toHaveBeenCalledTimes(1);
  },
);

portableTest(
  'rejects terminal stream contradictions before running a local function',
  async () => {
    const tool = lookup();
    const provider: NativeModel = {
      complete() {
        throw new Error('Expected the stream adapter');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        const event = {
          type: 'response.completed',
          response: { id: 'duplicate', status: 'completed', output: [call] },
        };
        yield event;
        yield event;
      },
    };
    await expect(
      runWorkerText('Find the value.', {
        control,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool.declaration],
        provider,
        observe() {},
      }),
    ).rejects.toThrow('emitted data after completion');
    expect(tool.execute).not.toHaveBeenCalled();
  },
);

portableTest(
  'commits and restores native session history with a fresh declaration',
  async () => {
    let stored: string | null = null;
    const expectedRevisions: number[] = [];
    const session = {
      id: 'worker-session',
      store: {
        acquire: vi.fn(async () => 'fence'),
        read: vi.fn(async () => stored),
        commit: vi.fn(async (_id, _fence, _writeId, expected, snapshot) => {
          expectedRevisions.push(expected);
          stored = snapshot;
        }),
        release: vi.fn(async () => {}),
      },
    };
    const requests: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'answer ' + requests.length },
              ],
            },
          ],
        };
      },
    };
    await expect(
      runWorkerText('first', {
        control,
        provider,
        model: 'fixture',
        instructions: 'old',
        session,
      }),
    ).resolves.toBe('answer 1');
    await expect(
      runWorkerText('second', {
        control,
        provider,
        model: 'fixture',
        instructions: 'new',
        session,
      }),
    ).resolves.toBe('answer 2');
    expect(expectedRevisions).toEqual([0, 1]);
    const input = JSON.stringify(requests[1].input);
    expect(input).toContain('new');
    expect(input).toContain('first');
    expect(input).toContain('answer 1');
    expect(input).toContain('second');
    expect(input).not.toContain('old');
    expect(session.store.release.mock.calls).toEqual([
      ['worker-session', 'fence'],
      ['worker-session', 'fence'],
    ]);
  },
);

portableTest(
  'releases the store without dispatching a provider for invalid history',
  async () => {
    const provider = {
      complete: vi.fn(async () => ({ output: [] })),
    };
    const session = {
      id: 'corrupt',
      store: {
        acquire: vi.fn(async () => 'fence'),
        read: vi.fn(async () =>
          JSON.stringify({
            version: 1,
            revision: 2,
            history: [
              {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'bad' }],
              },
            ],
          }),
        ),
        commit: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
      },
    };
    await expect(
      runWorkerText('begin', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Current',
        session,
      }),
    ).rejects.toThrow('Unsupported portable session history');
    expect(provider.complete).not.toHaveBeenCalled();
    expect(session.store.commit).not.toHaveBeenCalled();
    expect(session.store.release).toHaveBeenCalledWith('corrupt', 'fence');
  },
);

portableTest(
  'rejects a streamed tool call that changes in the completed output',
  async () => {
    const tool = lookup();
    const provider: NativeModel = {
      complete() {
        throw new Error('Expected the stream adapter');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        yield { type: 'response.created', response: { id: 'response' } };
        yield {
          type: 'response.output_item.done',
          output_index: 0,
          item: call,
        };
        yield {
          type: 'response.completed',
          response: {
            id: 'response',
            status: 'completed',
            output: [{ ...call, arguments: '{"value":"injected"}' }],
          },
        };
      },
    };
    await expect(
      runWorkerText('Find it.', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool.declaration],
        observe() {},
      }),
    ).rejects.toThrow('changed completed output');
    expect(tool.execute).not.toHaveBeenCalled();
  },
);
