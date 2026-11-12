import type { JsonObject } from '../../src/runtime/binding';
import { describe, expect, it, vi } from 'vitest';
import {
  applyPatchTool,
  type ApplyPatchEditor,
} from '../../src/runtime/apply-patch';
import {
  captureTools,
  invokeFunctionTool,
  type ToolCallContext,
} from '../../src/runtime/tools';

function context(): ToolCallContext<unknown> {
  return {
    context: undefined,
    submission: { sessionId: 'root', turnId: 'turn', submissionId: 's' },
    threadId: 'root',
    turnId: 'turn',
    callId: 'patch-1',
    signal: new AbortController().signal,
  } as ToolCallContext<unknown>;
}
const call = (operation: JsonObject) => ({
  type: 'apply_patch_call',
  call_id: 'patch-1',
  operation,
});
function editor() {
  return {
    createFile: vi.fn(() => undefined),
    updateFile: vi.fn(() => undefined),
    deleteFile: vi.fn(() => undefined),
  } satisfies ApplyPatchEditor;
}

describe('native application Apply Patch adapter', () => {
  it('retains typed declaration and original editor callbacks', async () => {
    const source = editor();
    const original = source.deleteFile;
    const tool = applyPatchTool({ editor: source });
    source.deleteFile = vi.fn();
    expect(JSON.parse(captureTools([tool]).specsJson)).toEqual([
      { type: 'applyPatch' },
    ]);
    await invokeFunctionTool(
      tool,
      call({ type: 'delete_file', path: 'custom path' }),
      context(),
      () => {},
    );
    expect(original).toHaveBeenCalledOnce();
    expect(source.deleteFile).not.toHaveBeenCalled();
  });
  it('preserves application paths, diff and optional move destination', async () => {
    const source = editor();
    const current = context();
    await invokeFunctionTool(
      applyPatchTool({ editor: source }),
      call({
        type: 'update_file',
        path: 'tenant://one/../opaque',
        diff: 'custom format',
        move_to: 'remote://two',
      }),
      current,
      () => {},
    );
    expect(source.updateFile).toHaveBeenCalledWith(
      {
        type: 'update_file',
        path: 'tenant://one/../opaque',
        diff: 'custom format',
        moveTo: 'remote://two',
      },
      expect.objectContaining(current),
    );
  });
  it.each([
    undefined,
    { output: 'done' },
    { status: 'failed' as const, output: 'refused' },
  ])('retains declared result status and text: %j', async (returned) => {
    const source: ApplyPatchEditor = {
      ...editor(),
      async createFile() {
        return returned;
      },
    };
    const output = await invokeFunctionTool(
      applyPatchTool({ editor: source }),
      call({ type: 'create_file', path: 'virtual', diff: 'diff' }),
      context(),
      () => {},
    );
    const expected = { status: 'completed', ...returned };
    expect(output).toEqual({
      success: expected.status === 'completed',
      contentItems: [{ type: 'inputText', text: JSON.stringify(expected) }],
    });
  });
  it.each([
    { type: 'create_file', path: 'x', diff: 17 },
    { type: 'update_file', path: 'x', diff: 'd', move_to: '' },
    { type: 'delete_file', path: null },
  ])(
    'rejects malformed operations before editor entry: %j',
    async (operation) => {
      const source = editor();
      await expect(
        invokeFunctionTool(
          applyPatchTool({ editor: source }),
          call(operation as JsonObject),
          context(),
          () => {},
        ),
      ).rejects.toThrow();
      expect(source.createFile).not.toHaveBeenCalled();
      expect(source.updateFile).not.toHaveBeenCalled();
      expect(source.deleteFile).not.toHaveBeenCalled();
    },
  );
  it('keeps final admission and body entry before an effect', async () => {
    const source = editor();
    const entry = vi.fn();
    const admission = vi.fn(() => {
      throw new Error('expired admission');
    });
    await expect(
      invokeFunctionTool(
        applyPatchTool({ editor: source }),
        call({ type: 'delete_file', path: 'x' }),
        context(),
        () => {},
        admission,
        undefined,
        undefined,
        undefined,
        entry,
      ),
    ).rejects.toThrow('expired admission');
    expect(entry).not.toHaveBeenCalled();
    expect(source.deleteFile).not.toHaveBeenCalled();
  });
});
