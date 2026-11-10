import { afterEach, expect, it, vi, type TestContext } from 'vitest';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment } from '@openai/agents';
import { call, message, ModelServer } from './fixtures/model-server';
import {
  functionOutput,
  modelInput,
  providerFor,
  seedProject,
  writeRule,
} from './fixtures/project-guidance/project';

afterEach(() => ModelServer.closeAll());

const supported = process.platform === 'linux' || process.platform === 'darwin';
const marker = 'DIRECT_JADE';
const outsideText = 'SYNTHETIC_OUTSIDE_WORKSPACE';

function currentCanonicalGuidance(request: ModelServer['requests'][number]) {
  // Older blocks can remain in the request as superseded history.
  let latest: string | undefined;
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.role !== 'user' ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const part of item.content) {
      if (
        part &&
        typeof part === 'object' &&
        !Array.isArray(part) &&
        part.type === 'input_text' &&
        typeof part.text === 'string'
      ) {
        const text = part.text.trim();
        if (
          text.startsWith('<canonical_rules>') &&
          text.endsWith('</canonical_rules>')
        ) {
          latest = text;
        }
      }
    }
  }
  expect(latest).toMatch(
    /^<canonical_rules>Current canonical project guidance; replaces all earlier canonical rules\.\n/,
  );
  return latest;
}

function openGuidedSession(
  agent: Agent,
  environment: Environment,
  server: ModelServer,
  context: TestContext,
) {
  return agent
    .session({ environment, projectGuidance: true })
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        /^local executor could not establish the platform sandbox(?:$|: AppArmor has restricted)/.test(
          error.message,
        ) &&
        process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
      ) {
        expect(server.requests).toHaveLength(0);
        context.skip('This host cannot launch a nested platform sandbox');
      }
      throw error;
    });
}

it.skipIf(!supported).for([
  ['read_text_file', 'src/source.txt', 'relative', 'alias'],
  ['read_text_file', 'src/source.txt', 'physical absolute', 'alias'],
  ['read_text_file', 'src/source.txt', 'alias absolute', 'alias'],
  ['view_image', 'src/pixel.png', 'relative', 'alias'],
  ['view_image', 'src/pixel.png', 'physical absolute', 'alias'],
  ['view_image', 'src/pixel.png', 'alias absolute', 'alias'],
  ['read_text_file', 'src/source.txt', 'physical absolute', 'physical'],
  ['view_image', 'src/pixel.png', 'physical absolute', 'physical'],
  ['read_text_file', 'src/outside.txt', 'outside symlink', 'alias'],
  ['read_text_file', 'src/outside.txt', 'outside symlink', 'physical'],
  ['view_image', 'src/outside.png', 'outside symlink', 'alias'],
] as const)(
  '%s reads %s via %s (cwd: %s)',
  { timeout: 150_000 },
  async ([operation, file, pathKind, cwdKind], context) => {
    const scratch = await mkdtemp(
      join(await realpath(tmpdir()), 'local-rules-'),
    );
    try {
      const root = join(scratch, 'project');
      const alias = join(scratch, 'project-alias');
      await seedProject(root, marker);
      await writeRule(scratch, 'ancestor', 'DIRECT_ANCESTOR_RUBY');
      await mkdir(join(scratch, '.git'));
      await symlink(root, alias, 'dir');

      const outsideSymlink = pathKind === 'outside symlink';
      const denied = outsideSymlink || pathKind === 'alias absolute';
      if (outsideSymlink) {
        const outside = join(
          scratch,
          operation === 'view_image' ? 'outside.png' : 'outside.txt',
        );
        if (operation === 'view_image') {
          await copyFile(join(root, 'src/pixel.png'), outside);
        } else {
          await writeFile(outside, outsideText);
        }
        await symlink(outside, join(root, file));
      }
      const path = {
        relative: file,
        'physical absolute': join(root, file),
        'alias absolute': join(alias, file),
        'outside symlink': file,
      }[pathKind];
      const callId = `direct-${operation}-${cwdKind}`;
      const server = new ModelServer([
        [call(operation, { path }, { callId })],
        [message('read checked')],
      ]);
      const cwd = cwdKind === 'alias' ? alias : root;
      const environment = Environment.local({ cwd, tools: [] });
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        instructions: 'Answer.',
        model: 'gpt-5',
      });
      await using session = await openGuidedSession(
        agent,
        environment,
        server,
        context,
      );
      expect(
        (await (await session.submit('Read the file.')).wait()).finalOutput,
      ).toBe('read checked');
      server.assertExhausted();

      const [before, after] = server.requests;
      for (const request of server.requests) {
        expect(Array.isArray(request.tools)).toBe(true);
        expect(JSON.stringify(request.tools)).not.toMatch(
          /"name":"(?:exec_command|write_stdin)"/,
        );
        expect(modelInput(request)).not.toMatch(
          /DIRECT_JADE_UNRELATED|DIRECT_ANCESTOR_RUBY/,
        );
      }
      expect(JSON.stringify(before!.tools)).toContain(`"name":"${operation}"`);
      expect(modelInput(before!)).not.toContain(`${marker}_SCOPED`);

      const output = functionOutput(after!, callId);
      if (denied) {
        expect(output).toMatchObject({
          call_id: callId,
          output: expect.stringMatching(
            operation === 'view_image'
              ? /^unable to locate image at .*\b(?:not permitted|Permission denied|No such file or directory)\b/i
              : /^read_text_file: .*\b(?:not permitted|Permission denied|No such file or directory)\b/i,
          ),
        });
        expect(modelInput(after!)).not.toContain(outsideText);
        if (operation === 'view_image') {
          expect(modelInput(after!)).not.toMatch(
            /"type":"input_image"|data:image\/png;base64,/,
          );
        }
        expect(modelInput(after!)).not.toContain(`${marker}_SCOPED`);
      } else if (operation === 'view_image') {
        const png = await readFile(join(root, file));
        expect(output).toMatchObject({
          call_id: callId,
          output: [
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${png.toString('base64')}`,
            },
          ],
        });
      } else {
        expect(output).toMatchObject({
          call_id: callId,
          output: JSON.stringify('executor text content'),
        });
      }

      expect(currentCanonicalGuidance(before!)).toContain(`${marker}_GENERAL`);
      const guidance = currentCanonicalGuidance(after!);
      expect(guidance).toContain(`${marker}_GENERAL`);
      if (!denied) expect(guidance).toContain(`${marker}_SCOPED`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported).for(['untrusted', 'trusted'] as const)(
  'uses the %s physical project trust for an aliased local cwd',
  { timeout: 150_000 },
  async (trust, context) => {
    const scratch = await mkdtemp(
      join(await realpath(tmpdir()), 'local-rules-trust-'),
    );
    try {
      const root = join(scratch, 'project');
      const alias = join(scratch, 'project-alias');
      const home = join(scratch, 'home');
      await seedProject(root, marker);
      await symlink(root, alias, 'dir');
      await mkdir(home);
      await writeFile(
        join(home, 'config.toml'),
        `[projects.${JSON.stringify(alias)}]\ntrust_level = "trusted"\n` +
          `[projects.${JSON.stringify(root)}]\ntrust_level = "${trust}"\n`,
      );
      vi.stubEnv('CODEX_HOME', home);

      const path = 'src/pixel.png';
      const callId = 'direct-trust-image';
      const server = new ModelServer([
        [call('view_image', { path }, { callId })],
        [message('read checked')],
      ]);
      const environment = Environment.local({ cwd: alias, tools: [] });
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        instructions: 'Answer.',
        model: 'gpt-5',
      });
      await using session = await openGuidedSession(
        agent,
        environment,
        server,
        context,
      );
      expect(
        (await (await session.submit('Read the image.')).wait()).finalOutput,
      ).toBe('read checked');
      server.assertExhausted();

      const [before, after] = server.requests;
      expect(JSON.stringify(before!.tools)).toContain('"name":"view_image"');
      const png = await readFile(join(root, path));
      expect(functionOutput(after!, callId)).toMatchObject({
        call_id: callId,
        output: [
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${png.toString('base64')}`,
          },
        ],
      });

      expect(modelInput(before!)).not.toContain(`${marker}_SCOPED`);
      if (trust === 'trusted') {
        expect(currentCanonicalGuidance(before!)).toContain(
          `${marker}_GENERAL`,
        );
        const guidance = currentCanonicalGuidance(after!);
        expect(guidance).toContain(`${marker}_GENERAL`);
        expect(guidance).toContain(`${marker}_SCOPED`);
      } else {
        expect(modelInput(before!)).not.toContain(`${marker}_GENERAL`);
        expect(modelInput(after!)).not.toContain(`${marker}_GENERAL`);
        expect(modelInput(after!)).not.toContain(`${marker}_SCOPED`);
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
