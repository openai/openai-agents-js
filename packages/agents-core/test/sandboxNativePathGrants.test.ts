import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Manifest, skills } from '../src/sandbox';
import { sandboxPathGrantHostPath } from '../src/sandbox/internal';
import {
  localDirLazySkillSource,
  UnixLocalSandboxClient,
} from '../src/sandbox/local';

describe('native sandbox path grants', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('rejects hostPath for UnixLocal before creating a workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-native-grant-'));
    tempDirs.push(root);
    const hostSource = join(root, 'shared-data');
    const workspaceBaseDir = join(root, 'workspaces');
    await mkdir(hostSource);
    await mkdir(workspaceBaseDir);

    const client = new UnixLocalSandboxClient({ workspaceBaseDir });
    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [
            {
              path: '/mnt/shared-data',
              hostPath: hostSource,
              readOnly: true,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'unsupported_feature',
      details: {
        provider: 'UnixLocalSandboxClient',
        feature: 'manifest.extraPathGrants.hostPath',
        path: '/mnt/shared-data',
      },
    });
    await expect(readdir(workspaceBaseDir)).resolves.toEqual([]);
  });

  it('uses hostPath for lazy local skill discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-native-skills-'));
    tempDirs.push(root);
    const skillsRoot = join(root, 'skills');
    const skillDir = join(skillsRoot, 'native-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: native-skill',
        'description: Loaded through a native host path',
        '---',
        '# Native skill',
      ].join('\n'),
    );

    const capability = skills({
      lazyFrom: localDirLazySkillSource(skillsRoot),
    });
    const manifest = new Manifest({
      extraPathGrants: [
        {
          path: '/mnt/shared-skills',
          hostPath: skillsRoot,
          readOnly: true,
        },
      ],
    });

    await expect(capability.instructions(manifest)).resolves.toContain(
      '- native-skill: Loaded through a native host path (file: .agents/native-skill)',
    );
  });

  it('rejects drive-less hostPath values on Windows', () => {
    if (process.platform !== 'win32') {
      return;
    }
    const manifest = new Manifest({
      extraPathGrants: [
        {
          path: '/mnt/shared-data',
          hostPath: '/Users/example/shared-data',
          readOnly: true,
        },
      ],
    });

    expect(() =>
      sandboxPathGrantHostPath(manifest.extraPathGrants[0]!),
    ).toThrow(/hostPath must be drive-qualified on Windows/i);
  });
});
