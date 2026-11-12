import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  DockerSandboxClient,
  Manifest,
  dir,
  file,
} from '@openai/agents-core/sandbox/local';
import { Environment } from '../src/runtime/environment';
import {
  SandboxSkillBinding,
  SandboxSkillLease,
  skills,
} from '../src/runtime/sandbox-skills';

const DOCKER_TEST_IMAGE = 'python:3.14-slim';
const dockerAvailable =
  spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10_000 })
    .status === 0 &&
  spawnSync('docker', ['image', 'inspect', DOCKER_TEST_IMAGE], {
    stdio: 'ignore',
    timeout: 10_000,
  }).status === 0;

it.skipIf(!dockerAvailable)(
  'charges a real Docker partial extraction before admitting another lazy skill',
  async () => {
    const MiB = 1024 * 1024;
    const client = new DockerSandboxClient({ image: DOCKER_TEST_IMAGE });
    const sandbox = await client.create({
      manifest: new Manifest({ root: '/workspace' }),
      snapshot: { type: 'noop' },
    });
    const binding = new SandboxSkillBinding(
      skills({
        lazyFrom: {
          source: dir({
            children: Object.fromEntries(
              ['alpha', 'beta'].map((name) => [
                name,
                dir({
                  children: {
                    'SKILL.md': file({
                      content: `---\nname: ${name}\ndescription: failed write quota\n---\n`,
                    }),
                    'first.bin': file({ content: new Uint8Array(16 * MiB) }),
                    'last.bin': file({ content: new Uint8Array(17 * MiB) }),
                  },
                }),
              ]),
            ),
          }),
        },
      }),
    );
    const environment = new Environment({
      url: 'wss://fixture.invalid',
      cwd: '/workspace',
      capabilityDirectories: ['/workspace/.agents'],
      tools: [],
    });
    const lease = new SandboxSkillLease(
      binding,
      sandbox,
      environment,
      sandbox.state.manifest,
      '/workspace',
      true,
    );
    try {
      await lease.activate();
      sandbox.setArchiveLimits({ maxExtractedBytes: 20 * MiB });
      const load = (name: string) =>
        lease.load(name, new AbortController().signal);
      await expect(load('alpha')).rejects.toThrow(
        /extracted size exceeds limit/i,
      );
      expect(
        (
          await sandbox.readFile({
            path: '.agents/alpha/first.bin',
            maxBytes: 1,
          })
        ).byteLength,
      ).toBe(1);
      expect(await sandbox.pathExists('.agents/alpha/SKILL.md')).toBe(true);
      await expect(load('alpha')).rejects.toThrow(/incomplete/i);
      await expect(load('beta')).rejects.toThrow(/skill tree byte limit/i);
      expect(await sandbox.pathExists('.agents/beta/SKILL.md')).toBe(false);
      expect(await sandbox.pathExists('.agents/beta/first.bin')).toBe(false);
    } finally {
      lease.retire();
      await sandbox.close();
      await promisify(execFile)('docker', [
        'rm',
        '-f',
        sandbox.state.containerId,
      ]);
    }
  },
  60_000,
);
