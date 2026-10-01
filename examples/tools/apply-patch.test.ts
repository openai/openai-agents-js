import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, Runner, applyPatchTool } from '@openai/agents';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';
import { WorkspaceEditor } from './apply-patch';

describe('apply-patch workspace editor', () => {
  let parent: string;
  let root: string;
  let editor: WorkspaceEditor;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'apply-patch-test-'));
    root = path.join(parent, 'workspace');
    await mkdir(root);
    editor = new WorkspaceEditor(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(parent, { recursive: true, force: true });
  });

  it('rejects sibling-prefix creation before creating directories', async () => {
    await expect(
      editor.createFile({
        type: 'create_file',
        path: '../workspace-sibling/nested/new.txt',
        diff: '+new\n+',
      }),
    ).rejects.toThrow('Operation outside workspace:');
    await expect(
      stat(path.join(parent, 'workspace-sibling')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['update_file', 'delete_file'] as const)(
    'rejects sibling-prefix %s without changing the existing file',
    async (type) => {
      const sibling = path.join(parent, 'workspace-sibling');
      await mkdir(sibling);
      const target = path.join(sibling, 'existing.txt');
      await writeFile(target, 'original\n');
      const operationPath = '../workspace-sibling/existing.txt';
      const result =
        type === 'update_file'
          ? editor.updateFile({
              type,
              path: operationPath,
              diff: '@@\n-original\n+changed',
            })
          : editor.deleteFile({ type, path: operationPath });

      await expect(result).rejects.toThrow('Operation outside workspace:');
      expect(await readFile(target, 'utf8')).toBe('original\n');
    },
  );

  it.each(['absolute-sibling', 'parent'] as const)(
    'rejects an outside %s path',
    async (kind) => {
      const target =
        kind === 'absolute-sibling'
          ? path.join(parent, 'workspace-sibling', 'new.txt')
          : path.join(parent, 'new.txt');
      await expect(
        editor.createFile({
          type: 'create_file',
          path: kind === 'absolute-sibling' ? target : '../new.txt',
          diff: '+new\n+',
        }),
      ).rejects.toThrow('Operation outside workspace:');
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([
    'nested/file.txt',
    '..notes',
    'nested/../normalized.txt',
    'absolute',
  ])(
    'preserves in-workspace create, update, and delete for %s',
    async (input) => {
      const operationPath =
        input === 'absolute' ? path.join(root, 'absolute.txt') : input;
      const target = path.resolve(root, operationPath);
      await editor.createFile({
        type: 'create_file',
        path: operationPath,
        diff: '+original\n+',
      });
      expect(await readFile(target, 'utf8')).toBe('original\n');
      await editor.updateFile({
        type: 'update_file',
        path: operationPath,
        diff: '@@\n-original\n+changed',
      });
      expect(await readFile(target, 'utf8')).toBe('changed\n');
      await editor.deleteFile({ type: 'delete_file', path: operationPath });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('returns a failed tool result for an approved escaping model operation', async () => {
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = new ScriptedModel([
      [
        {
          type: 'apply_patch_call',
          callId: 'outside-workspace',
          status: 'completed',
          operation: {
            type: 'create_file',
            path: '../workspace-sibling/new.txt',
            diff: '+new\n+',
          },
        },
      ],
      [assistantMessage('Done')],
    ]);
    const agent = new Agent({
      name: 'Patch test',
      model,
      tools: [
        applyPatchTool({
          editor,
          needsApproval: true,
          onApproval: async () => ({ approve: true }),
        }),
      ],
    });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      'Apply the patch',
    );
    expect(
      result.newItems.find(
        (item) => item.rawItem.type === 'apply_patch_call_output',
      )?.rawItem,
    ).toMatchObject({
      status: 'failed',
      output: 'Operation outside workspace: ../workspace-sibling/new.txt',
    });
    await expect(
      stat(path.join(parent, 'workspace-sibling')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    model.assertComplete();
    expect(loggedError).toHaveBeenCalledWith(
      'Failed to execute apply_patch operation:',
      expect.anything(),
    );
  });
});
