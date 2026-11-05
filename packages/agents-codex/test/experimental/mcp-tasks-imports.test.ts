import { execFileSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each(['cjs', 'mjs'] as const)(
  'reports missing optional packages through the real %s export from another working directory',
  async (extension) => {
    const root = await mkdtemp(join(tmpdir(), 'agents-mcp-tasks-import-'));
    try {
      const installed = join(root, 'node_modules/@openai/agents-codex');
      const source = resolve(__dirname, '../..');
      const manifest = JSON.parse(
        await readFile(join(source, 'package.json'), 'utf8'),
      ) as { optionalDependencies: Record<string, string> };
      const clientVersion =
        manifest.optionalDependencies['@modelcontextprotocol/client'];
      const coreVersion =
        manifest.optionalDependencies['@modelcontextprotocol/core'];
      await mkdir(join(installed, 'experimental'), { recursive: true });
      await copyFile(
        join(source, 'package.json'),
        join(installed, 'package.json'),
      );
      for (const file of ['mcp-tasks.cjs', 'mcp-tasks.mjs']) {
        await copyFile(
          join(source, 'experimental', file),
          join(installed, 'experimental', file),
        );
      }
      const probe = join(root, `probe.${extension}`);
      const load =
        extension === 'cjs'
          ? "require('@openai/agents-codex/experimental/mcp-tasks')"
          : "await import('@openai/agents-codex/experimental/mcp-tasks')";
      await writeFile(
        probe,
        `
        (async () => {
          let result = { loaded: true };
          try { ${load}; }
          catch (error) { result = { message: error.message, cause: error.cause ?? null }; }
          process.stdout.write(JSON.stringify(result));
        })();
      `,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_PATH: '',
        NODE_OPTIONS: '',
      };
      delete env.OPENAI_API_KEY;
      const result = JSON.parse(
        execFileSync(process.execPath, [probe], {
          cwd: tmpdir(),
          env,
          encoding: 'utf8',
          timeout: 5_000,
        }),
      );
      expect(result).toEqual({
        message: `MCP Tasks requires optional dependencies. Install @modelcontextprotocol/client@${clientVersion} and @modelcontextprotocol/core@${coreVersion}.`,
        cause: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
