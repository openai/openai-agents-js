import { afterEach, expect, it, vi } from 'vitest';
import * as runtime from '@openai/agents-core/sandbox/internal';
import { Agent } from '../../src';
import { captureSandboxMemory } from '../../src/runtime/sandbox-memory';

afterEach(() => vi.restoreAllMocks());

it('deduplicates an interruption but supersedes it on settlement at the same canonical revision', async () => {
  const files = new Map<string, Uint8Array>();
  const store = {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, data: Uint8Array) => {
      files.set(path, data.slice());
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    list: async (prefix: string) =>
      [...files.keys()].filter((path) => path.startsWith(prefix)),
  };
  let calls = 0;
  vi.spyOn(Agent.prototype, 'run').mockImplementation(async () => {
    calls++;
    return {
      finalOutput:
        calls % 2
          ? {
              rollout_summary: 'Approval pending.',
              rollout_slug: 'pending',
              raw_memory: 'No effect.',
            }
          : { summary: 'No effect.', memory: 'No effect.' },
    } as never;
  });
  const makeOwner = captureSandboxMemory(
    {
      phaseOne: new Agent({ instructions: 'Extract.' }),
      phaseTwo: new Agent({ instructions: 'Consolidate.' }),
      store,
    },
    runtime,
  );
  const resource = {
    state: {
      sessionId: 'resource',
      workspaceRootPath: '/workspace',
      manifest: { entries: {} },
    },
    pathExists: async () => false,
    materializeEntry: async () => undefined,
    readFileNoFollow: async () => null,
    writeFileNoFollow: async () => undefined,
  } as unknown as Parameters<typeof makeOwner>[0];
  const owner = makeOwner(resource);
  const snapshot = {
    revision: 'native-revision',
    total: 1,
    items: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'begin' }],
      },
    ],
  };
  const interrupted = {
    terminal_state: 'interrupted' as const,
    exception_type: null,
    exception_message: null,
    has_final_output: false,
    capture_key: 'native-turn',
    pending_tool_name: 'risky',
  };
  await owner.flush('thread', snapshot, interrupted);
  await owner.flush('thread', snapshot, interrupted);
  expect(calls).toBe(2);
  const path = [...files.keys()].find((path) => path.endsWith('.jsonl'))!;
  const first = JSON.parse(new TextDecoder().decode(files.get(path)!));
  expect(first.terminal_metadata.terminal_state).toBe('interrupted');
  expect(first.terminal_metadata.native_history_revision).toBe(
    'native-revision',
  );
  expect(JSON.stringify(first)).not.toContain('capture_key');
  await owner.flush('thread', snapshot, {
    terminal_state: 'completed',
    exception_type: null,
    exception_message: null,
    has_final_output: true,
    capture_key: 'native-turn',
  });
  expect(calls).toBe(4);
  const cold = JSON.parse(new TextDecoder().decode((await store.read(path))!));
  expect(cold.terminal_metadata.terminal_state).toBe('completed');
  expect(cold.terminal_metadata.native_history_revision).toBe(
    'native-revision',
  );
  expect(cold.terminal_metadata.pending_tool_name).toBeUndefined();
  expect([...files.keys()].filter((path) => path.endsWith('.jsonl'))).toEqual([
    path,
  ]);
});
