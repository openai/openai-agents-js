import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiSdkModel,
  runWorkerText,
  runWorkerTurn,
  WorkerGuardrailTripwire,
  standaloneTool,
  type NativeModel,
} from '../src/runtime/workerd';
import type { AiSdkLanguageModel } from '../src/runtime/models';
import type { JsonObject } from '../src/runtime/binding';
import { HermesTextControl } from '../src/runtime/turn-control-binding';

const wasm = new URL('../native/codex-turn-control.wasm', import.meta.url);
const portableTest = it.skipIf(!existsSync(wasm));
let control: WebAssembly.Module;

beforeAll(async () => {
  if (!existsSync(wasm)) return;
  const bytes = await readFile(wasm);
  control = new WebAssembly.Module(bytes);
});

portableTest(
  'runs with the lowered host contract and missing Hermes globals',
  async () => {
    // Use actual Rust exports to exercise the same host ABI in the regular suite.
    const instantiate = vi.fn(
      () =>
        new WebAssembly.Instance(control).exports as unknown as ReturnType<
          HermesTextControl['instantiate']
        >,
    );
    const module = new HermesTextControl(instantiate);
    const previousRawCheck = JSON.isRawJSON;
    vi.stubGlobal('TextDecoder', undefined);
    vi.stubGlobal('structuredClone', undefined);
    Object.defineProperty(JSON, 'isRawJSON', {
      configurable: true,
      value: undefined,
    });
    try {
      async function run(input: string) {
        const tool = lookup();
        let calls = 0;
        const result = await runWorkerText(input, {
          control: module,
          model: 'fixture',
          instructions: 'Use lookup.',
          tools: [tool.declaration],
          provider: {
            async complete({ body }) {
              if (++calls === 1) {
                expect(JSON.stringify(body.input)).toContain(input);
                return { output: [call] };
              }
              expect(JSON.stringify(body.input)).toContain('observed:local');
              return {
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: input }],
                  },
                ],
              };
            },
          },
        });
        expect(tool.execute).toHaveBeenCalledTimes(1);
        return result;
      }
      await expect(
        Promise.all([run('海豚 🐬'), run('separate')]),
      ).resolves.toEqual(['海豚 🐬', 'separate']);
      expect(instantiate).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(JSON, 'isRawJSON', {
        configurable: true,
        value: previousRawCheck,
      });
      vi.unstubAllGlobals();
    }
  },
);

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

portableTest(
  'keeps observer changes out of the admitted tool arguments',
  async () => {
    const tool = lookup();
    let requests = 0;
    const provider: NativeModel = {
      complete() {
        throw new Error('Expected the stream adapter');
      },
      async *stream(): AsyncGenerator<JsonObject> {
        requests++;
        yield {
          type: 'response.completed',
          response: {
            id: String(requests),
            status: 'completed',
            output:
              requests === 1
                ? [call]
                : [
                    {
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: 'done' }],
                    },
                  ],
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
        observe(event) {
          if (requests !== 1 || event.type !== 'response.completed') return;
          const response = event.response as JsonObject;
          const output = response.output as JsonObject[];
          output[0].arguments = '{"value":"injected"}';
        },
      }),
    ).resolves.toBe('done');
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(tool.execute.mock.calls[0][0]).toEqual({ value: 'local' });
  },
);

portableTest(
  'transfers to the captured Worker profile and restores it on the next turn',
  async () => {
    const tool = lookup();
    const requests: JsonObject[] = [];
    const transfer = {
      type: 'function_call',
      name: 'transfer_to_destination',
      call_id: 'transfer',
      arguments: '{}',
    };
    const assistant = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'handoff accepted' }],
    };
    let stored: string | null = null;
    const session = {
      id: 'handoff-history',
      store: {
        acquire: async () => 'fence',
        read: async () => stored,
        commit: async (
          _id: string,
          _fence: string,
          _writeId: string,
          _revision: number,
          next: string,
        ) => {
          stored = next;
        },
        release: async () => {},
      },
    };
    const root: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return { output: [transfer] };
      },
    };
    const destination: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return { output: requests.length === 2 ? [call] : [assistant] };
      },
    };
    const agents = {
      root: 'root',
      profiles: {
        root: {
          model: 'root',
          instructions: 'Transfer to destination.',
          handoffs: { transfer_to_destination: 'destination' },
        },
        destination: {
          model: 'destination',
          instructions: 'Use lookup.',
          provider: destination,
          tools: [tool.declaration],
        },
      },
    };
    const options = {
      control,
      model: 'root',
      instructions: '',
      provider: root,
      session,
      agents,
    };
    await expect(runWorkerText('Transfer.', options)).resolves.toBe(
      'handoff accepted',
    );
    await expect(runWorkerText('Continue.', options)).resolves.toBe(
      'handoff accepted',
    );
    expect(requests.map((body) => body.model)).toEqual([
      'root',
      'destination',
      'destination',
      'destination',
    ]);
    expect(requests[0].tools).toEqual([
      expect.objectContaining({ name: 'transfer_to_destination' }),
    ]);
    expect(requests[1].tools).toEqual([
      expect.objectContaining({ name: 'lookup' }),
    ]);
    expect(JSON.stringify(requests[1].input)).not.toContain(
      'Transfer to destination.',
    );
    expect(JSON.stringify(requests[3].input)).toContain('observed:local');
    expect(tool.execute).toHaveBeenCalledTimes(1);
  },
);

portableTest.each([true, false])(
  'adjudicates Worker tool admission before side effects (%s)',
  async (approved) => {
    const tool = lookup();
    const asks: unknown[] = [];
    const responses: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        responses.push(body);
        return {
          output:
            responses.length === 1
              ? [call]
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
    await expect(
      runWorkerText('Ask first.', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool.declaration],
        approve: {
          lookup(request) {
            expect(tool.execute).not.toHaveBeenCalled();
            asks.push(request.arguments);
            return approved;
          },
        },
      }),
    ).resolves.toBe('done');
    expect(asks).toEqual([{ value: 'local' }]);
    expect(tool.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
    expect(JSON.stringify(responses[1].input)).toContain(
      approved ? 'observed:local' : 'Tool call denied.',
    );
  },
);

portableTest.each(['approve', 'deny', 'lost result'] as const)(
  'resumes a stored Worker approval in a fresh native instance (%s)',
  async (outcome) => {
    let stored: string | null = null;
    const revisions: number[] = [];
    const session = {
      id: 'approval-session',
      store: {
        acquire: vi.fn(async () => 'fence'),
        read: vi.fn(async () => stored),
        async commit(
          _id: string,
          _fence: string,
          _writeId: string,
          expected: number,
          snapshot: string,
        ) {
          if (outcome === 'lost result' && expected === 2)
            throw new Error('Store unavailable');
          expect(stored === null ? 0 : JSON.parse(stored).revision).toBe(
            expected,
          );
          revisions.push(expected);
          stored = snapshot;
        },
        release: vi.fn(async () => {}),
      },
    };
    const asks = vi.fn(() => null);
    const original = lookup();
    const tool = lookup();
    const requests: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output:
            requests.length === 1
              ? [call]
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
    const options = {
      control,
      provider,
      model: 'fixture',
      instructions: 'Use lookup.',
      session,
    };
    const paused = await runWorkerTurn('Ask first.', {
      ...options,
      tools: [original.declaration],
      approve: { lookup: asks },
    });
    expect(paused).toEqual({
      type: 'approval',
      callId: 'test-call',
      revision: 1,
      name: 'lookup',
      profile: null,
      arguments: { value: 'local' },
    });
    expect(original.execute).not.toHaveBeenCalled();
    expect(revisions).toEqual([0]);

    const resume = {
      ...options,
      tools: [tool.declaration],
      approve: { lookup: asks },
    };
    const decision = {
      callId: 'test-call',
      revision: 1,
      approved: outcome !== 'deny',
    };
    await expect(
      runWorkerTurn({ ...decision, revision: 2 }, resume),
    ).rejects.toThrow('does not match the pending call');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);

    if (outcome === 'lost result') {
      await expect(runWorkerTurn(decision, resume)).rejects.toThrow(
        'Store unavailable',
      );
      await expect(runWorkerTurn(decision, resume)).rejects.toThrow(
        'already claimed',
      );
      expect(revisions).toEqual([0, 1]);
    } else {
      await expect(runWorkerTurn(decision, resume)).resolves.toEqual({
        type: 'completed',
        text: 'done',
      });
      await expect(runWorkerTurn(decision, resume)).rejects.toThrow(
        'No portable approval is pending',
      );
      expect(revisions).toEqual(outcome === 'approve' ? [0, 1, 2] : [0, 1]);
    }
    expect(asks).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(outcome === 'deny' ? 0 : 1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].input)).toContain(
      outcome === 'deny' ? 'Tool call denied.' : 'observed:local',
    );
    expect(session.store.release).toHaveBeenCalledTimes(4);
  },
);

portableTest(
  'commits a fresh inline approval before dispatch in a stored turn',
  async () => {
    let stored: string | null = null;
    const sideEffects = vi.fn(() => {
      expect(JSON.parse(stored ?? 'null')).toMatchObject({
        revision: 1,
        approval: { call_id: 'test-call', claimed: true },
      });
      return 'observed:local';
    });
    const provider: NativeModel = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({ output: [call] })
        .mockResolvedValueOnce({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'done' }],
            },
          ],
        }),
    };
    const session = {
      id: 'inline',
      store: {
        async acquire() {
          return 'fence';
        },
        async read() {
          return stored;
        },
        async commit(
          _id: string,
          _fence: string,
          _writeId: string,
          expected: number,
          snapshot: string,
        ) {
          expect(stored === null ? 0 : JSON.parse(stored).revision).toBe(
            expected,
          );
          stored = snapshot;
        },
        async release() {},
      },
    };
    const tool = standaloneTool({
      name: 'lookup',
      parameters: z.object({ value: z.string() }),
      execute: sideEffects,
    });
    await expect(
      runWorkerText('Look up.', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool],
        session,
        approve: { lookup: () => true },
      }),
    ).resolves.toBe('done');
    expect(sideEffects).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored ?? 'null')).toMatchObject({ revision: 2 });
  },
);

portableTest.each(['input', 'output', 'none'] as const)(
  'guards Worker text at the native request and acceptance boundaries (%s)',
  async (block) => {
    const events: string[] = [];
    const provider: NativeModel = {
      complete: vi.fn(async () => ({
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'draft' }],
          },
        ],
      })),
    };
    const owner = { id: 'guardrail-test' };
    const store = {
      acquire: vi.fn(async () => 'fence'),
      read: vi.fn(async () => null),
      commit: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const run = runWorkerText('Start.', {
      control,
      provider,
      model: 'fixture',
      instructions: 'Complete.',
      context: owner,
      session: { id: 'worker-guarded', store },
      inputGuardrails: [
        {
          name: 'check input',
          async callback({ text, context, sessionId }) {
            expect(context).toBe(owner);
            expect(sessionId).toBe('worker-guarded');
            events.push(text);
            return {
              tripwireTriggered: block === 'input',
              outputInfo: 'input receipt',
            };
          },
        },
      ],
      outputGuardrails: [
        {
          name: 'check output',
          async callback({ text, context }) {
            expect(context).toBe(owner);
            events.push(text);
            return {
              tripwireTriggered: block === 'output',
              outputInfo: 'output receipt',
            };
          },
        },
      ],
    });
    if (block === 'none') {
      await expect(run).resolves.toBe('draft');
      expect(store.commit).toHaveBeenCalledOnce();
    } else {
      const error = await run.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(WorkerGuardrailTripwire);
      expect(error).toMatchObject({
        kind: block,
        guardrail: 'check ' + block,
        result: { tripwireTriggered: true, outputInfo: block + ' receipt' },
      });
      expect(store.commit).not.toHaveBeenCalled();
    }
    expect(events).toEqual(
      block === 'input' ? ['Start.'] : ['Start.', 'draft'],
    );
    expect(provider.complete).toHaveBeenCalledTimes(block === 'input' ? 0 : 1);
    expect(store.release).toHaveBeenCalledOnce();
  },
);

portableTest.each([
  'input denial',
  'output denial',
  'input tripwire',
  'output tripwire',
  'allow',
] as const)(
  'guards the current Worker tool before and after execution (%s)',
  async (mode) => {
    const tool = lookup();
    const requests: JsonObject[] = [];
    const before = vi.fn(() => {
      if (mode === 'input denial')
        return { action: 'deny', reason: 'safe refusal' } as const;
      if (mode === 'input tripwire')
        return { action: 'stop', outputInfo: 'input receipt' } as const;
      return { action: 'allow' } as const;
    });
    const after = vi.fn(({ output }: { output: string }) => {
      expect(output).toBe('observed:local');
      if (mode === 'output denial')
        return { action: 'deny', reason: 'safe replacement' } as const;
      if (mode === 'output tripwire')
        return { action: 'stop', outputInfo: 'output receipt' } as const;
      return { action: 'allow' } as const;
    });
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output:
            requests.length === 1
              ? [call]
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
    const run = runWorkerText('Check the tool.', {
      control,
      provider,
      model: 'fixture',
      instructions: 'Use lookup.',
      tools: [tool.declaration],
      toolGuardrails: { lookup: [{ name: 'check', before, after }] },
    });
    if (mode.endsWith('tripwire')) {
      await expect(run).rejects.toMatchObject({
        kind: mode.startsWith('input') ? 'tool_input' : 'tool_output',
        guardrail: 'check',
      });
      expect(requests).toHaveLength(1);
    } else {
      await expect(run).resolves.toBe('done');
      expect(requests).toHaveLength(2);
      const outputs = (requests[1].input as JsonObject[]).filter(
        (item) => item.type === 'function_call_output',
      );
      expect(outputs).toEqual([
        {
          type: 'function_call_output',
          call_id: 'test-call',
          output:
            mode === 'input denial'
              ? 'safe refusal'
              : mode === 'output denial'
                ? 'safe replacement'
                : 'observed:local',
        },
      ]);
    }
    expect(before).toHaveBeenCalledTimes(1);
    expect(tool.execute).toHaveBeenCalledTimes(
      mode.startsWith('input') ? 0 : 1,
    );
    expect(after).toHaveBeenCalledTimes(mode.startsWith('input') ? 0 : 1);
  },
);

portableTest(
  'restores mixed Worker approval batches without repeating settled calls',
  async () => {
    const open = lookup();
    const effects: string[] = [];
    const makeTool = (name: string) =>
      standaloneTool({
        name,
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          const output = name + ':' + value;
          effects.push(output);
          return output;
        },
      });
    const revisions: number[] = [];
    let stored: string | null = null;
    const session = {
      id: 'mixed-approval',
      store: {
        async acquire() {
          return 'fence';
        },
        async read() {
          return stored;
        },
        async commit(
          _id: string,
          _fence: string,
          _writeId: string,
          expected: number,
          snapshot: string,
        ) {
          expect(stored === null ? 0 : JSON.parse(stored).revision).toBe(
            expected,
          );
          revisions.push(expected);
          stored = snapshot;
        },
        async release() {},
      },
    };
    const requests: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output:
            requests.length === 1
              ? [
                  { ...call, name: 'one', call_id: 'one' },
                  call,
                  { ...call, name: 'two', call_id: 'two' },
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
    const options = () => ({
      control,
      provider,
      model: 'fixture',
      instructions: 'Use both tools.',
      session,
      tools: [makeTool('one'), open.declaration, makeTool('two')],
      approve: { one: () => null, two: () => null },
    });
    await expect(runWorkerTurn('Ask first.', options())).resolves.toMatchObject(
      { type: 'approval', callId: 'one', revision: 1 },
    );
    expect(open.execute).toHaveBeenCalledOnce();
    expect(effects).toEqual([]);
    await expect(
      runWorkerTurn({ callId: 'one', revision: 1, approved: true }, options()),
    ).resolves.toMatchObject({ type: 'approval', callId: 'two', revision: 3 });
    await expect(
      runWorkerTurn({ callId: 'one', revision: 1, approved: true }, options()),
    ).rejects.toThrow('does not match');
    expect(requests).toHaveLength(1);
    await expect(
      runWorkerTurn({ callId: 'two', revision: 3, approved: false }, options()),
    ).resolves.toEqual({ type: 'completed', text: 'done' });
    expect(open.execute).toHaveBeenCalledOnce();
    expect(effects).toEqual(['one:local']);
    expect(revisions).toEqual([0, 1, 2, 3]);
    expect(
      (requests[1].input as JsonObject[]).filter(
        (item) => item.type === 'function_call_output',
      ),
    ).toEqual([
      { type: 'function_call_output', call_id: 'one', output: 'one:local' },
      {
        type: 'function_call_output',
        call_id: 'test-call',
        output: 'observed:local',
      },
      {
        type: 'function_call_output',
        call_id: 'two',
        output: 'Tool call denied.',
      },
    ]);
  },
);

portableTest.each([true, false])(
  'joins a parallel input check before admitting provider tool calls (%s)',
  async (tripwireTriggered) => {
    const events: string[] = [];
    let sampled!: () => void;
    const sampling = new Promise<void>((resolve) => {
      sampled = resolve;
    });
    const tool = standaloneTool({
      name: 'lookup',
      parameters: z.object({ value: z.string() }),
      execute: () => {
        events.push('tool');
        return 'value';
      },
    });
    let requests = 0;
    const provider: NativeModel = {
      async complete() {
        events.push('model');
        sampled();
        return {
          output:
            ++requests === 1
              ? [call]
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
    const result = runWorkerText('Check first.', {
      control,
      provider,
      model: 'fixture',
      instructions: 'Use lookup.',
      tools: [tool],
      inputGuardrails: [
        {
          name: 'parallel',
          runInParallel: true,
          async callback() {
            events.push('guard-start');
            await sampling;
            events.push('guard-end');
            return { tripwireTriggered };
          },
        },
      ],
    });
    if (tripwireTriggered)
      await expect(result).rejects.toMatchObject({
        kind: 'input',
        guardrail: 'parallel',
      });
    else await expect(result).resolves.toBe('done');
    expect(events).toEqual(
      tripwireTriggered
        ? ['guard-start', 'model', 'guard-end']
        : ['guard-start', 'model', 'guard-end', 'tool', 'model'],
    );
  },
);

portableTest(
  'binds approved Worker execution to the validated arguments',
  async () => {
    let currentTarget = 'initial';
    const execute = vi.fn(({ target }: { target: string }) => target);
    const declare = (replace = false) =>
      standaloneTool({
        name: 'lookup',
        parameters: z
          .object({
            target: z.string().optional(),
          })
          .transform(({ target }) => ({
            target: (target ?? currentTarget).toUpperCase(),
          })),
        before: replace
          ? () =>
              ({
                action: 'replaceArguments',
                arguments: { target: 'different' },
              }) as const
          : undefined,
        execute,
      });
    let stored: string | null = null;
    const session = {
      id: 'effective',
      store: {
        async acquire() {
          return 'fence';
        },
        async read() {
          return stored;
        },
        async commit(
          _id: string,
          _fence: string,
          _writeId: string,
          expected: number,
          snapshot: string,
        ) {
          expect(stored === null ? 0 : JSON.parse(stored).revision).toBe(
            expected,
          );
          stored = snapshot;
        },
        async release() {},
      },
    };
    const responses: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        responses.push(body);
        return {
          output:
            responses.length === 1
              ? [{ ...call, arguments: '{}' }]
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
    const policy = vi.fn(
      ({ arguments: args }: { arguments: Readonly<JsonObject> }) => {
        expect(args).toEqual({ target: 'INITIAL' });
        Reflect.set(args, 'target', 'CHANGED AFTER VALIDATION');
        return null;
      },
    );
    const options = (replace = false) => ({
      control,
      provider,
      model: 'fixture',
      instructions: 'Use lookup.',
      session,
      tools: [declare(replace)],
      approve: { lookup: policy },
    });
    await expect(runWorkerTurn('Ask first.', options())).resolves.toMatchObject(
      {
        type: 'approval',
        callId: 'test-call',
        revision: 1,
        arguments: { target: 'INITIAL' },
      },
    );
    expect(execute).not.toHaveBeenCalled();

    const decision = { callId: 'test-call', revision: 1, approved: true };
    currentTarget = 'changed';
    await expect(runWorkerTurn(decision, options())).rejects.toThrow(
      'arguments changed after validation',
    );
    expect(JSON.parse(stored ?? 'null').revision).toBe(1);
    expect(execute).not.toHaveBeenCalled();

    currentTarget = 'initial';
    await expect(runWorkerTurn(decision, options(true))).resolves.toEqual({
      type: 'completed',
      text: 'done',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(responses[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          output: 'Tool input policy changed approved arguments',
        }),
      ]),
    );
  },
);

portableTest(
  'executes a transformed Worker approval exactly once without validating it again',
  async () => {
    const transform = vi.fn((value: { text: string }) => ({
      text: value.text + '!',
    }));
    const execute = vi.fn((args: { text: string }) => args.text);
    const tool = standaloneTool({
      name: 'lookup',
      parameters: z
        .object({ text: z.string().default('ready') })
        .transform(transform),
      execute,
    });
    const requests: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output:
            requests.length === 1
              ? [{ ...call, arguments: '{}' }]
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
    await expect(
      runWorkerText('Ask.', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool],
        approve: {
          lookup({ arguments: args }) {
            expect(args).toEqual({ text: 'ready!' });
            return true;
          },
        },
      }),
    ).resolves.toBe('done');
    expect(transform).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      { text: 'ready!' },
      expect.anything(),
    );
  },
);

portableTest.each([true, false])(
  'runs Worker guards on the final parsed invocation arguments (%s)',
  async (deny) => {
    const execute = vi.fn(({ text }: { text: string }) => text);
    const guardBefore = vi.fn(
      ({ arguments: args }: { arguments: Readonly<JsonObject> }) => {
        expect(args).toEqual({ text: 'replacement!' });
        Reflect.set(args, 'text', 'guard mutated copy');
        return deny
          ? ({ action: 'deny', reason: 'safe denial' } as const)
          : ({ action: 'allow' } as const);
      },
    );
    const guardAfter = vi.fn(
      ({
        arguments: args,
        output,
      }: {
        arguments: Readonly<JsonObject>;
        output: string;
      }) => {
        expect(args).toEqual({ text: 'replacement!' });
        expect(output).toBe('replacement!');
        return { action: 'allow' } as const;
      },
    );
    const tool = standaloneTool({
      name: 'lookup',
      parameters: z
        .object({ text: z.string().default('ready') })
        .transform(({ text }) => ({ text: text + '!' })),
      before({ effectiveArguments }) {
        expect(effectiveArguments).toEqual({ text: 'ready!' });
        return {
          action: 'replaceArguments',
          arguments: { text: 'replacement' },
        };
      },
      execute,
    });
    const requests: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        requests.push(body);
        return {
          output:
            requests.length === 1
              ? [{ ...call, arguments: '{}' }]
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
    await expect(
      runWorkerText('Ask.', {
        control,
        provider,
        model: 'fixture',
        instructions: 'Use lookup.',
        tools: [tool],
        toolGuardrails: {
          lookup: [
            { name: 'effective', before: guardBefore, after: guardAfter },
          ],
        },
      }),
    ).resolves.toBe('done');
    expect(guardBefore).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(deny ? 0 : 1);
    if (!deny)
      expect(execute.mock.calls[0][0]).toEqual({ text: 'replacement!' });
    expect(guardAfter).toHaveBeenCalledTimes(deny ? 0 : 1);
    expect(requests[1].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          output: deny ? 'safe denial' : 'replacement!',
        }),
      ]),
    );
  },
);

portableTest.each([false, true])(
  'validates native Worker structured output through tool continuation (%s strict)',
  async (strict) => {
    const tool = lookup();
    const bodies: JsonObject[] = [];
    const provider: NativeModel = {
      async complete({ body }) {
        bodies.push(body);
        return {
          output:
            bodies.length === 1
              ? [call]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'output_text', text: '{"response":["native"]}' },
                    ],
                  },
                ],
        };
      },
    };
    const result = await runWorkerTurn('Run tool.', {
      control,
      provider,
      model: 'root',
      instructions: 'Run lookup.',
      tools: [tool.declaration],
      outputType: { mode: 'native', schema: z.array(z.string()), strict },
    });
    expect(result).toEqual({
      type: 'completed',
      text: '{"response":["native"]}',
      output: ['native'],
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies)
      expect(body.text).toEqual({
        format: expect.objectContaining({
          type: 'json_schema',
          name: 'codex_output_schema',
          strict,
          schema: expect.objectContaining({
            properties: expect.objectContaining({
              response: expect.objectContaining({ type: 'array' }),
            }),
          }),
        }),
      });
    expect(tool.execute).toHaveBeenCalledOnce();
  },
);

portableTest(
  'keeps rejected Worker output out of the durable snapshot',
  async () => {
    const store = {
      acquire: vi.fn(async () => 'fence'),
      read: vi.fn(async () => null),
      commit: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
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
              content: [{ type: 'output_text', text: '{"score":"invalid"}' }],
            },
          ],
        };
      },
    };
    await expect(
      runWorkerTurn('Return a score.', {
        control,
        provider,
        model: 'root',
        instructions: 'Grade.',
        session: { id: 'record', store },
        outputType: {
          mode: 'prompted',
          schema: z.object({ score: z.number() }),
          maxRetries: 0,
        },
      }),
    ).rejects.toMatchObject({ name: 'OutputValidationError' });
    expect(requests[0].text).toBeUndefined();
    expect(requests[0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'developer',
          content: [
            expect.objectContaining({
              text: expect.stringContaining('Return only JSON'),
            }),
          ],
        }),
      ]),
    );
    expect(store.commit).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledOnce();
  },
);

portableTest(
  'binds a cold approval to its original Worker output contract',
  async () => {
    let stored: string | null = null;
    const store = {
      async acquire() {
        return 'fence';
      },
      async read() {
        return stored;
      },
      async release() {},
      async commit(
        _id: string,
        _fence: string,
        _writeId: string,
        _revision: number,
        state: string,
      ) {
        stored = state;
      },
    };
    const tool = lookup();
    let requests = 0;
    const provider: NativeModel = {
      async complete() {
        return {
          output:
            ++requests === 1
              ? [call]
              : [
                  {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '{"score":3}' }],
                  },
                ],
        };
      },
    };
    const options = {
      control,
      provider,
      model: 'root',
      instructions: 'Run lookup.',
      tools: [tool.declaration],
      session: { id: 'scored', store },
      approve: { lookup: () => null },
    };
    const schema = z.object({ score: z.number() });
    const pause = await runWorkerTurn('Do it.', {
      ...options,
      outputType: schema,
    });
    if (pause.type !== 'approval')
      throw Error('Expected a pending tool approval');
    const { callId, revision } = pause;
    const decision = { callId, revision, approved: true };
    await expect(runWorkerTurn(decision, options)).rejects.toThrow(
      'original output contract',
    );
    await expect(
      runWorkerTurn(decision, {
        ...options,
        outputType: z.object({ score: z.string() }),
      }),
    ).rejects.toThrow('original output contract');
    expect(tool.execute).not.toHaveBeenCalled();
    expect(requests).toBe(1);
    await expect(
      runWorkerTurn(decision, { ...options, outputType: schema }),
    ).resolves.toEqual({
      type: 'completed',
      text: '{"score":3}',
      output: { score: 3 },
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(requests).toBe(2);
  },
);

portableTest(
  'projects typed Worker output through the AI SDK adapter',
  async () => {
    const provider = new AiSdkModel({
      specificationVersion: 'v3',
      provider: 'fixture',
      modelId: 'fixture',
      async doGenerate(options: { responseFormat: unknown }) {
        expect(options.responseFormat).toEqual(
          expect.objectContaining({
            type: 'json',
            name: 'codex_output_schema',
            schema: expect.objectContaining({ required: ['score'] }),
          }),
        );
        return {
          content: [{ type: 'text', text: '{"score":7}' }],
          finishReason: { unified: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        };
      },
    } as unknown as AiSdkLanguageModel);
    const result = await runWorkerTurn('Score it.', {
      control,
      provider,
      model: 'fixture',
      instructions: 'Score.',
      outputType: z.object({ score: z.number() }),
    });
    expect(result).toEqual({
      type: 'completed',
      text: '{"score":7}',
      output: { score: 7 },
    });
  },
);
