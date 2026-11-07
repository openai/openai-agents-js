import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  Runner,
  applyPatchTool,
  type Editor,
} from '@openai/agents/classic';
import { Manifest } from '@openai/agents/sandbox';
import {
  UnixLocalSandboxClient,
  type UnixLocalSandboxSession,
} from '@openai/agents/sandbox/local';
import {
  ScriptedModel,
  assistantMessage,
} from '@openai/agents/classic/testing';
describe('apply-patch example sandbox editor', () => {
  let parent: string;
  let root: string;
  let session: UnixLocalSandboxSession;
  let editor: Editor;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'apply-patch-test-'));
    session = await new UnixLocalSandboxClient({
      workspaceBaseDir: parent,
    }).create(new Manifest());
    root = session.state.workspaceRootPath;
    editor = session.createEditor();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await session.close();
    await rm(parent, { recursive: true, force: true });
  });

  it('rejects sibling-prefix creation before creating directories', async () => {
    await expect(
      editor.createFile({
        type: 'create_file',
        path: '../workspace-sibling/nested/new.txt',
        diff: '+new\n+',
      }),
    ).rejects.toThrow();
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

      await expect(result).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('original\n');
    },
  );

  it.each(['create_file', 'update_file', 'delete_file'] as const)(
    'does not write through a linked parent for %s',
    async (type) => {
      const outside = path.join(parent, 'outside');
      await mkdir(outside);
      const target = path.join(outside, 'note.txt');
      await writeFile(target, 'original\n');
      await symlink(outside, path.join(root, 'linked'));
      const operationPath = 'linked/note.txt';
      const action =
        type === 'create_file'
          ? editor.createFile({ type, path: operationPath, diff: '+new\n+' })
          : type === 'update_file'
            ? editor.updateFile({
                type,
                path: operationPath,
                diff: '@@\n-original\n+changed',
              })
            : editor.deleteFile({ type, path: operationPath });
      await expect(action).rejects.toThrow();
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
      ).rejects.toThrow();
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each(['nested/file.txt', '..notes', 'notes.txt'])(
    'preserves in-workspace create, update, and delete for %s',
    async (input) => {
      const operationPath = input;
      const target = path.join(root, input);
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

  it.each(['create_file', 'update_file'] as const)(
    'does not write through a linked file for %s',
    async (type) => {
      const target = path.join(parent, 'outside.txt');
      await writeFile(target, 'original\n');
      await symlink(target, path.join(root, 'linked.txt'));
      const action =
        type === 'create_file'
          ? editor.createFile({ type, path: 'linked.txt', diff: '+new\n+' })
          : editor.updateFile({
              type,
              path: 'linked.txt',
              diff: '@@\n-original\n+changed',
            });
      await expect(action).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('original\n');
    },
  );

  it('removes a linked file itself without deleting its target', async () => {
    const target = path.join(parent, 'outside.txt');
    await writeFile(target, 'original\n');
    const link = path.join(root, 'linked.txt');
    await symlink(target, link);
    await editor.deleteFile({ type: 'delete_file', path: 'linked.txt' });
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(target, 'utf8')).toBe('original\n');
  });

  it('returns a failed tool result for an approved linked model operation', async () => {
    const loggedError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    const target = path.join(outside, 'note.txt');
    await writeFile(target, 'original\n');
    await symlink(outside, path.join(root, 'linked'));
    const model = new ScriptedModel([
      [
        {
          type: 'apply_patch_call',
          callId: 'linked-workspace',
          status: 'completed',
          operation: {
            type: 'create_file',
            path: 'linked/note.txt',
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
      output: expect.stringMatching(/workspace|symlink/),
    });
    expect(await readFile(target, 'utf8')).toBe('original\n');
    model.assertComplete();
    expect(loggedError).toHaveBeenCalledWith(
      'Failed to execute apply_patch operation:',
      expect.anything(),
    );
  });
});
