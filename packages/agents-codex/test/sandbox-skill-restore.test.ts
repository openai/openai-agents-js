import { expect, it, vi } from 'vitest';
import { Manifest, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import { SandboxSkillBinding, skills } from '../src/runtime/sandbox-skills';

it.each([false, true])(
  'skips unrelated directories and preserves retired-root file cleanup with confined removal=%s',
  async (confined) => {
    const manifest = new Manifest();
    const remove = vi.fn(async (_operation: { path: string }) => ({
      status: 'completed' as const,
    }));
    const materializeEntry = vi.fn(async () => {});
    const listDir = vi.fn(async ({ path }: { path: string }) => {
      if (path === '.agents')
        return [
          { name: 'report', type: 'dir', path: '.agents/report' },
          { name: 'retired', type: 'dir', path: '.agents/retired' },
          { name: 'unrelated', type: 'dir', path: '.agents/unrelated' },
        ];
      if (path === '.agents/report')
        return [
          { name: 'old.sh', type: 'file', path: '.agents/report/old.sh' },
        ];
      if (path === '.agents/retired')
        return [
          { name: 'SKILL.md', type: 'file', path: '.agents/retired/SKILL.md' },
          { name: 'nested', type: 'dir', path: '.agents/retired/nested' },
        ];
      if (path === '.agents/retired/nested')
        return [
          {
            name: 'old.sh',
            type: 'file',
            path: '.agents/retired/nested/old.sh',
          },
        ];
      throw new Error('Unrelated directory must not be listed');
    });
    const binding = new SandboxSkillBinding(
      skills({
        skills: [
          { name: 'report', description: 'current', content: 'current' },
        ],
      }),
    );
    await binding.stageOwnedResume(
      {
        state: { manifest },
        listDir,
        removeEntryNoFollow: confined
          ? async (path: string) => {
              await remove({ path });
            }
          : undefined,
        pathExists: async (path: string) => path === '.agents/retired/SKILL.md',
        createEditor: () => ({ deleteFile: remove }),
        materializeEntry,
      } as unknown as SandboxSessionLike,
      manifest,
      [
        [
          '.agents/report',
          {
            type: 'dir',
            children: { 'SKILL.md': { type: 'file', content: 'current' } },
          },
        ],
      ],
      new AbortController().signal,
    );
    expect(remove.mock.calls.map(([op]) => op.path).sort()).toEqual([
      '.agents/report/old.sh',
      '.agents/retired/SKILL.md',
      '.agents/retired/nested/old.sh',
    ]);
    expect(listDir.mock.calls.map(([args]) => args.path)).toEqual([
      '.agents',
      '.agents/report',
      '.agents/retired',
      '.agents/retired/nested',
    ]);
    expect(materializeEntry).toHaveBeenCalledOnce();
  },
);

it('rejects a special-file sentinel in a retired skill root', async () => {
  const manifest = new Manifest();
  const binding = new SandboxSkillBinding(
    skills({
      skills: [{ name: 'report', description: 'current', content: 'current' }],
    }),
  );
  await expect(
    binding.stageOwnedResume(
      {
        state: { manifest },
        materializeEntry: async () => {},
        pathExists: async () => true,
        listDir: async ({ path }: { path: string }) =>
          path === '.agents'
            ? [{ name: 'retired', path: '.agents/retired', type: 'dir' }]
            : [
                {
                  name: 'SKILL.md',
                  path: '.agents/retired/SKILL.md',
                  type: 'other',
                },
              ],
      } as unknown as SandboxSessionLike,
      manifest,
      [['.agents/report', { type: 'dir', children: {} }]],
      new AbortController().signal,
    ),
  ).rejects.toThrow('unsupported member');
});

it('rejects direct-clone eager Git restore before cleanup without source preparation', async () => {
  const manifest = new Manifest();
  const listDir = vi.fn(async () => []);
  const removeEntryNoFollow = vi.fn(async () => {});
  const materializeEntry = vi.fn(async () => {});
  const binding = new SandboxSkillBinding(
    skills({
      from: {
        type: 'git_repo',
        repo: 'fixture/skills',
      },
    }),
  );
  await expect(
    binding.stageOwnedResume(
      {
        state: { manifest },
        listDir,
        removeEntryNoFollow,
        materializeEntry,
      },
      manifest,
      [['.agents', { type: 'git_repo', repo: 'fixture/skills' }]],
      new AbortController().signal,
    ),
  ).rejects.toThrow(/source preparation support/);
  expect(listDir).not.toHaveBeenCalled();
  expect(removeEntryNoFollow).not.toHaveBeenCalled();
  expect(materializeEntry).not.toHaveBeenCalled();
});
