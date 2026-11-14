import {
  runWorkerTurn,
  standaloneTool,
  type WorkerTextOptions,
} from '../../src/runtime/workerd';
import { z } from 'zod';
import type { OutputSpec } from '../../src/runtime/output';

export async function finishFixture(
  control: WebAssembly.Module,
  mode:
    | 'single'
    | 'ordered'
    | 'cold'
    | 'guard'
    | 'invalid'
    | 'changed'
    | 'claimed'
    | 'two'
    | 'tampered'
    | 'array'
    | 'model-array' = 'single',
) {
  let requests = 0,
    stored: string | null = null;
  const effects: string[] = [];
  const guards: string[] = [];
  const mixed = [
    'ordered',
    'cold',
    'changed',
    'claimed',
    'two',
    'tampered',
  ].includes(mode);
  const resultValue =
    mode === 'invalid'
      ? 'invalid JSON'
      : mode === 'array'
        ? '[1,2]'
        : '{"answer":42}';
  const finisher = standaloneTool({
    name: 'finish',
    finishTurn: true,
    parameters: z.object({}),
    async execute() {
      effects.push('finish');
      if (mode === 'ordered')
        await new Promise((resolve) => setTimeout(resolve, 5));
      return resultValue;
    },
  });
  const sibling = standaloneTool({
    name: 'sibling',
    finishTurn: mode === 'two',
    parameters: z.object({}),
    async execute() {
      effects.push('sibling');
      if (mode === 'two')
        await new Promise((resolve) => setTimeout(resolve, 5));
      return mode === 'two' ? '{"answer":7}' : 'sibling output';
    },
  });
  const calls = [
    ...(mixed
      ? [
          {
            type: 'function_call',
            name: 'sibling',
            call_id: 'sibling-call',
            arguments: '{}',
          },
        ]
      : []),
    {
      type: 'function_call',
      name: 'finish',
      call_id: 'finish-call',
      arguments: '{}',
    },
  ];
  const provider = {
    async complete() {
      if (mode === 'model-array') {
        requests++;
        return {
          tool_output: true,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '[1,2]' }],
            },
          ],
        };
      }
      if (++requests > 1)
        throw Error('Unexpected model resampling after finishing tool');
      return { output: calls };
    },
  };
  const store = {
    async acquire() {
      return 'owner';
    },
    async read() {
      return stored;
    },
    async release() {},
    async commit(
      _id: string,
      _fence: string,
      _write: string,
      expected: number,
      value: string,
    ) {
      if ((stored === null ? 0 : JSON.parse(stored).revision) !== expected)
        throw Error('Stale finish revision');
      stored = value;
    },
  };
  const outputType: OutputSpec<unknown> = ['array', 'model-array'].includes(
    mode,
  )
    ? z.array(z.number())
    : z.object({ answer: z.number() });
  const options: WorkerTextOptions<undefined> = {
    control,
    provider,
    model: 'fixture',
    instructions: 'Finish with the tool.',
    maxTurns: 1,
    tools: mixed ? [sibling, finisher] : [finisher],
    session: { id: 'finish-owner', store },
    outputGuardrails: [
      {
        name: 'final',
        callback: ({ text }) => {
          guards.push(text);
          return { tripwireTriggered: false, outputInfo: 'checked' };
        },
      },
    ],
    ...(['cold', 'changed', 'claimed', 'tampered'].includes(mode)
      ? { approve: { sibling: () => null } }
      : {}),
    ...(mode === 'guard'
      ? {
          toolGuardrails: {
            finish: [
              {
                name: 'deny',
                before: () => ({
                  action: 'deny' as const,
                  reason: 'guard denied',
                }),
              },
            ],
          },
        }
      : {}),
  };
  if (mode === 'invalid' || mode === 'guard' || mode === 'model-array') {
    let error = '';
    try {
      await runWorkerTurn('Start.', {
        ...options,
        outputType,
      });
    } catch (value) {
      error = String(value);
    }
    if (
      !error ||
      stored !== null ||
      requests !== 1 ||
      effects.length !== (mode === 'guard' || mode === 'model-array' ? 0 : 1)
    )
      throw Error('Wrong guarded or invalid finishing result');
    return { mode, rejected: true, effects, requests, guards };
  }
  let result = await runWorkerTurn('Start.', {
    ...options,
    outputType,
  });
  if (['cold', 'changed', 'claimed', 'tampered'].includes(mode)) {
    if (
      result.type !== 'approval' ||
      effects.join(',') !== 'finish' ||
      guards.length !== 0
    )
      throw Error('Finishing output escaped the pending approval gate');
    if (mode === 'tampered') {
      const snapshot = JSON.parse(stored!);
      snapshot.approval.finish_calls[0][0] = 'foreign-finisher';
      stored = JSON.stringify(snapshot);
    }
    if (mode === 'claimed') {
      const snapshot = JSON.parse(stored!);
      snapshot.approval.claimed = true;
      stored = JSON.stringify(snapshot);
    }
    const restored = {
      ...options,
      outputType,
      ...(mode === 'cold'
        ? {
            tools: [
              sibling,
              standaloneTool({
                name: 'finish',
                finishTurn: true,
                parameters: z.object({}),
                execute() {
                  throw Error('Settled finishing producer replayed');
                },
              }),
            ],
          }
        : {}),
      ...(mode === 'changed'
        ? {
            tools: [
              sibling,
              standaloneTool({
                name: 'finish',
                finishTurn: false,
                parameters: z.object({}),
                execute() {
                  throw Error('Changed producer executed');
                },
              }),
            ],
          }
        : {}),
    };
    let error = '';
    try {
      result = await runWorkerTurn(
        { callId: result.callId, revision: result.revision, approved: true },
        restored,
      );
    } catch (value) {
      error = String(value);
    }
    if (mode === 'changed' || mode === 'claimed' || mode === 'tampered') {
      if (!error || effects.join(',') !== 'finish' || requests !== 1)
        throw Error('Changed or claimed finishing producer admitted effects');
      return { mode, rejected: true, effects, requests, guards };
    }
    if (error) throw Error(error);
  }
  if (
    result.type !== 'completed' ||
    JSON.stringify(result.output) !==
      (mode === 'array'
        ? '[1,2]'
        : mode === 'two'
          ? '{"answer":7}'
          : '{"answer":42}') ||
    requests !== 1 ||
    guards.length !== 1
  )
    throw Error('Wrong finishing output');
  if (
    effects.filter((name) => name === 'finish').length !== 1 ||
    effects.filter((name) => name === 'sibling').length !== (mixed ? 1 : 0)
  )
    throw Error('Duplicate or missing finishing batch effects');
  const history = JSON.parse(stored!).history;
  const ids = history
    .filter((item: any) => item.type === 'function_call_output')
    .map((item: any) => item.call_id);
  if (JSON.stringify(ids) !== JSON.stringify(calls.map((call) => call.call_id)))
    throw Error('Finishing batch changed output order');
  return {
    mode,
    result: result.output,
    effects,
    requests,
    guards: guards.length,
    outputIds: ids,
  };
}
