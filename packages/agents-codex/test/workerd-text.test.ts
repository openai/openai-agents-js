import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { beforeAll, expect, it, vi } from 'vitest';
import {
  AiSdkModel,
  runWorkerText,
  standaloneTool,
  type NativeModel,
} from '../src/runtime/workerd';
import type { AiSdkLanguageModel } from '../src/runtime/models';

const wasm = new URL('../native/codex-turn-control.wasm', import.meta.url);
const portableTest = it.skipIf(!existsSync(wasm));
let control: WebAssembly.Module;

beforeAll(async () => {
  if (!existsSync(wasm)) return;
  const bytes = await readFile(wasm);
  control = new WebAssembly.Module(bytes);
});

function lookup(execute = vi.fn(({ value }) => 'observed:' + value)) {
  return {
    execute,
    declaration: standaloneTool({
      name: 'lookup',
      description: 'Read a local value.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
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
