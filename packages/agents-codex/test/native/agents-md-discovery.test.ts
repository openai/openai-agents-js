import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Agent,
  Environment,
  type Session,
  type SessionState,
} from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => vi.unstubAllEnvs());

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

async function sample(session: Session) {
  const turn = await session.submit('Continue.');
  expect((await turn.wait()).finalOutput).toBe('Done.');
  for await (const record of session.turns()) {
    if (record.id === turn.turnId) return record.receipt;
  }
  throw new Error('Missing sampled turn');
}

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'loads user and readable local project files in native precedence order',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-md-discovery-'));
    try {
      const directory = await realpath(temporary);
      const home = join(directory, 'home');
      const root = join(directory, 'project');
      const cwd = join(root, 'nested');
      await Promise.all([
        mkdir(home),
        mkdir(join(root, '.git'), { recursive: true }),
        mkdir(join(root, '.codex'), { recursive: true }),
        mkdir(cwd, { recursive: true }),
      ]);
      const user = join(home, 'AGENTS.override.md');
      const project = join(root, 'AGENTS.md');
      const nested = join(cwd, 'AGENTS.override.md');
      const explicit = join(directory, 'explicit.md');
      await Promise.all([
        writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
        writeFile(user, '\n  HOME_OVERRIDE  \n'),
        writeFile(project, 'PROJECT_ROOT\n'),
        writeFile(nested, 'NESTED_OVERRIDE\n'),
        writeFile(explicit, 'EXPLICIT_INSTRUCTIONS\r\n'),
        writeFile(join(home, 'AGENTS.md'), 'HOME_COMPETING'),
        writeFile(join(cwd, 'AGENTS.md'), 'NESTED_COMPETING'),
        writeFile(join(directory, 'AGENTS.md'), 'OUTSIDE_PROJECT'),
        writeFile(
          join(home, 'config.toml'),
          'This user config is invalid TOML.',
        ),
        writeFile(
          join(root, '.codex', 'config.toml'),
          'This project config is invalid TOML.',
        ),
      ]);
      vi.stubEnv('CODEX_HOME', home);
      const environment = Environment.local({ cwd, writableRoots: [root] });

      await withScriptedResponses(
        Array.from({ length: 4 }, () => [text('Done.')]),
        async (peer) => {
          const agent = new Agent({
            model: 'gpt-5',
            instructions: 'Application instructions.',
            provider: peer.provider,
          });
          const options = { environment, instructionFiles: [explicit] };
          const applicationFile = {
            path: explicit,
            source: 'application_file',
            sha256: sha256('EXPLICIT_INSTRUCTIONS\r\n'),
          };
          const projectFile = {
            path: project,
            source: 'native_project',
            sha256: sha256('PROJECT_ROOT\n'),
          };
          const userFile = {
            path: user,
            source: 'native_user',
            sha256: sha256('HOME_OVERRIDE'),
          };
          const nestedFile = {
            path: nested,
            source: 'native_project',
            sha256: sha256('NESTED_OVERRIDE\n'),
          };
          {
            await using session = await agent.session(options);
            expect((await sample(session))?.instructionFiles).toEqual([
              applicationFile,
            ]);
            expect(JSON.stringify(peer.requests[0]?.input)).not.toMatch(
              /HOME_OVERRIDE|PROJECT_ROOT|NESTED_OVERRIDE/,
            );
          }
          {
            await using session = await agent.session({
              ...options,
              discoverAgentsMd: true,
            });
            expect(await sample(session)).toMatchObject({
              userConfigApplied: false,
              instructionFiles: [
                applicationFile,
                userFile,
                projectFile,
                nestedFile,
              ],
            });
            const request = peer.requests[1]!;
            expect(request.model).toBe('gpt-5');
            expect(request.input).toContainEqual(
              expect.objectContaining({
                role: 'developer',
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.stringContaining(
                      'Application instructions.\n\nEXPLICIT_INSTRUCTIONS\r\n',
                    ),
                  }),
                ]),
              }),
            );
            expect(request.input).toContainEqual(
              expect.objectContaining({
                role: 'user',
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: expect.stringMatching(
                      /HOME_OVERRIDE[\s\S]*PROJECT_ROOT[\s\S]*NESTED_OVERRIDE/,
                    ),
                  }),
                ]),
              }),
            );
            expect(JSON.stringify(request.input)).not.toMatch(
              /HOME_COMPETING|NESTED_COMPETING|OUTSIDE_PROJECT/,
            );
          }
          {
            await using session = await agent.session({
              environment: Environment.local({ cwd }),
              discoverAgentsMd: true,
            });
            expect((await sample(session))?.instructionFiles).toEqual([
              userFile,
              nestedFile,
            ]);
            const input = JSON.stringify(peer.requests[2]?.input);
            expect(input).toMatch(/HOME_OVERRIDE.*NESTED_OVERRIDE/);
            expect(input).not.toMatch(
              /HOME_COMPETING|PROJECT_ROOT|NESTED_COMPETING|OUTSIDE_PROJECT/,
            );
          }
          {
            await mkdir(join(cwd, '.git'));
            await writeFile(
              join(cwd, '.git', 'HEAD'),
              'ref: refs/heads/main\n',
            );
            await using session = await agent.session({
              environment,
              discoverAgentsMd: true,
            });
            expect((await sample(session))?.instructionFiles).toEqual([
              userFile,
              nestedFile,
            ]);
            expect(JSON.stringify(peer.requests[3]?.input)).not.toMatch(
              /PROJECT_ROOT|OUTSIDE_PROJECT/,
            );
          }
        },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);

it('uses the current opening opt-in and explicit files when restoring state', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'agents-md-restore-'));
  try {
    const home = await realpath(temporary);
    const user = join(home, 'AGENTS.md');
    const explicit = join(home, 'application.md');
    await writeFile(user, '\n  ORIGINAL_HOME  \n');
    await writeFile(explicit, 'EXPLICIT_INSTRUCTIONS\r\n');
    await writeFile(
      join(home, 'config.toml'),
      'This user config is invalid TOML.',
    );
    vi.stubEnv('CODEX_HOME', home);
    await withScriptedResponses(
      Array.from({ length: 3 }, () => [text('Done.')]),
      async (peer) => {
        const agent = new Agent({
          instructions: 'Application instructions.',
          provider: peer.provider,
        });
        const instructionFiles = [explicit];
        const applicationFile = {
          path: explicit,
          source: 'application_file',
          sha256: sha256('EXPLICIT_INSTRUCTIONS\r\n'),
        };
        let state: SessionState;
        {
          await using session = await agent.session({
            instructionFiles,
            discoverAgentsMd: true,
          });
          expect(await sample(session)).toMatchObject({
            userConfigApplied: false,
            instructionFiles: [
              applicationFile,
              {
                path: user,
                source: 'native_user',
                sha256: sha256('ORIGINAL_HOME'),
              },
            ],
          });
          state = await session.saveState();
        }
        await writeFile(user, 'CURRENT_HOME');
        {
          await using session = await agent.session({
            instructionFiles,
            state,
          });
          expect((await sample(session))?.instructionFiles).toEqual([
            applicationFile,
          ]);
          const input = JSON.stringify(peer.requests[1]?.input);
          expect(input).toContain(
            'previously provided AGENTS.md instructions no longer apply',
          );
          expect(input).not.toContain('CURRENT_HOME');
        }
        {
          await using session = await agent.session({
            instructionFiles,
            state,
            discoverAgentsMd: true,
          });
          expect((await sample(session))?.instructionFiles).toEqual([
            applicationFile,
            {
              path: user,
              source: 'native_user',
              sha256: sha256('CURRENT_HOME'),
            },
          ]);
          expect(JSON.stringify(peer.requests[2]?.input)).toContain(
            'CURRENT_HOME',
          );
        }
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);

it('uses the current host Codex home in each opted-in one-shot run', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'agents-md-home-'));
  try {
    const homes = ['FIRST_HOME', 'SECOND_HOME'];
    for (const marker of homes) {
      const home = join(temporary, marker);
      await mkdir(home);
      await writeFile(join(home, 'AGENTS.md'), marker);
    }
    await withScriptedResponses(
      Array.from({ length: 3 }, () => [text('Done.')]),
      async (peer) => {
        const agent = new Agent({
          instructions: 'Application instructions.',
          model: 'gpt-5',
          provider: peer.provider,
        });
        for (const marker of homes) {
          vi.stubEnv('CODEX_HOME', join(temporary, marker));
          expect(
            (await agent.run('Go.', { discoverAgentsMd: true })).finalOutput,
          ).toBe('Done.');
          expect(JSON.stringify(peer.requests.at(-1)?.input)).toContain(marker);
        }
        await agent.run('Go.', { discoverAgentsMd: false });
        expect(JSON.stringify(peer.requests[2]?.input)).not.toMatch(
          /FIRST_HOME|SECOND_HOME/,
        );
      },
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);

it('discovers only the authenticated remote project hierarchy and host user file', async () => {
  const executor = await startPublicExecutor({
    authorization: 'Bearer synthetic-agents-discovery-fixture',
  });
  try {
    const home = join(dirname(executor.cwd), 'home');
    const cwd = join(executor.cwd, 'nested');
    await Promise.all([mkdir(home), mkdir(cwd)]);
    const user = join(await realpath(home), 'AGENTS.md');
    const root = join(executor.cwd, 'AGENTS.md');
    const nested = join(cwd, 'AGENTS.override.md');
    const outside = join(dirname(executor.cwd), 'AGENTS.md');
    const files = [
      { path: user, source: 'native_user', contents: 'HOST_USER' },
      { path: root, source: 'native_project', contents: 'REMOTE_ROOT\n' },
      { path: nested, source: 'native_project', contents: 'REMOTE_NESTED\n' },
    ];
    await Promise.all([
      ...files.map(({ path, contents }) => writeFile(path, contents)),
      writeFile(join(executor.cwd, '.git'), 'gitdir: ../worktree-metadata\n'),
      writeFile(join(cwd, 'AGENTS.md'), 'REMOTE_COMPETING'),
      writeFile(outside, 'OUTSIDE_REMOTE_PROJECT'),
    ]);
    vi.stubEnv('CODEX_HOME', home);
    await withScriptedResponses([[text('Done.')]], async (peer) => {
      const agent = new Agent({
        instructions: 'Application instructions.',
        provider: peer.provider,
      });
      await using session = await agent.session({
        discoverAgentsMd: true,
        environment: new Environment({
          cwd,
          url: executor.url,
          headers: executor.headers,
        }),
      });
      expect(await sample(session)).toMatchObject({
        userConfigApplied: false,
        instructionFiles: files.map(({ path, source, contents }) => ({
          path,
          source,
          sha256: sha256(contents),
        })),
      });
      expect(peer.requests[0]?.input).toContainEqual(
        expect.objectContaining({
          role: 'user',
          content: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringMatching(
                /HOST_USER[\s\S]*REMOTE_ROOT\n[\s\S]*REMOTE_NESTED\n/,
              ),
            }),
          ]),
        }),
      );
      expect(JSON.stringify(peer.requests[0]?.input)).not.toMatch(
        /OUTSIDE_REMOTE_PROJECT|REMOTE_COMPETING/,
      );
    });
    expect(executor.rejectedUpgrades).toEqual([]);
    const reads = executor.requests
      .filter((request) => request.method === 'fs/readFile')
      .map((request) => (request.params as { path: string }).path);
    expect(reads).toEqual(
      expect.arrayContaining([
        pathToFileURL(root).href,
        pathToFileURL(nested).href,
      ]),
    );
    expect(reads).not.toContain(pathToFileURL(outside).href);
  } finally {
    await executor.close();
  }
}, 30_000);
