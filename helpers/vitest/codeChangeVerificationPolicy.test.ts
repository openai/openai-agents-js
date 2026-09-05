import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const rootDir = resolve(import.meta.dirname, '../..');
const skillPath = resolve(
  rootDir,
  '.agents/skills/code-change-verification/SKILL.md',
);
const promptPath = resolve(
  rootDir,
  '.agents/skills/code-change-verification/agents/openai.yaml',
);
const workflowPath = resolve(rootDir, '.github/workflows/test.yml');

describe('code-change verification policy', () => {
  it('keeps Codex execution inside the workspace sandbox', () => {
    const skill = readFileSync(skillPath, 'utf8');
    const prompt = readFileSync(promptPath, 'utf8');
    const sandboxPolicy =
      'Never request elevated sandbox permissions for verification, and never retry with broader host access after a failure.';

    expect(skill).toContain(sandboxPolicy);
    expect(prompt).toContain(sandboxPolicy);
    expect(skill).not.toContain('sandbox_permissions=require_escalated');
    expect(prompt).not.toContain('sandbox_permissions=require_escalated');
    expect(skill).not.toContain('outside the Codex sandbox');
    expect(prompt).not.toContain('outside the Codex sandbox');
    expect(skill).toContain(
      '/usr/bin/env -u OPENAI_API_KEY bash .agents/skills/code-change-verification/scripts/run.sh',
    );
  });

  describe.each(['pull_request', 'push'])('%s routing', (eventName) => {
    it.each([
      ['docs/src/scripts/translate.ts', true],
      ['docs/src/scripts/headingAnchors.test.ts', true],
      ['docs/src/plugins/rehypeCanonicalHeadingIds.ts', true],
      ['docs/tsconfig.scripts.json', true],
      ['docs/astro.config.mjs', true],
      ['docs/package.json', true],
      ['integration-tests/released-api-contract.test.ts', true],
      ['integration-tests/_helpers/env.ts', true],
      ['integration-tests/node/package.json', true],
      ['examples/docs/tools.ts', true],
      ['packages/agents-core/src/run.ts', true],
      ['pnpm-lock.yaml', true],
      ['pnpm-workspace.yaml', true],
      ['package.json', true],
      ['tsconfig.json', true],
      ['vitest.integration.config.ts', true],
      ['.github/workflows/docs.yml', true],
      ['.agents/skills/code-change-verification/SKILL.md', true],
      ['.agents/skills/maintainer-review/SKILL.md', false],
      ['docs/src/content/docs/guides/tools.mdx', false],
      ['docs/README.md', false],
      ['docs/src/assets/light-logo.svg', false],
      ['README.md', false],
    ])('%s routes SDK CI to %s', async (filename, expected) => {
      expect(await runFilter(eventName, { files: [{ filename }] })).toBe(
        String(expected),
      );
    });

    it.each([
      '.agents/skills/code-change-verification/SKILL.md',
      'docs/src/scripts/headingAnchors.test.ts',
      'integration-tests/released-api-contract.test.ts',
      'examples/docs/tools.ts',
    ])('checks both sides of a rename from %s', async (previous_filename) => {
      expect(
        await runFilter(eventName, {
          files: [{ filename: '.agents/archive/notes.md', previous_filename }],
        }),
      ).toBe('true');
    });

    it('runs CI for mixed editorial and executable changes', async () => {
      expect(
        await runFilter(eventName, {
          files: [
            { filename: 'README.md' },
            { filename: 'examples/docs/tools.ts' },
          ],
        }),
      ).toBe('true');
    });

    it('defaults to CI for empty or unavailable file lists', async () => {
      expect(await runFilter(eventName, { files: [] })).toBe('true');
      expect(await runFilter(eventName, { apiError: true })).toBe('true');
    });
  });

  it('does not skip CI when pull request file evidence is incomplete', async () => {
    expect(await runFilter('pull_request', { changedFiles: 2 })).toBe('true');
    expect(await runFilter('pull_request', { changedFiles: undefined })).toBe(
      'true',
    );
    expect(
      await runFilter('pull_request', {
        files: Array.from({ length: 3000 }, (_, i) => ({
          filename: `docs/page-${i}.md`,
        })),
      }),
    ).toBe('true');
  });

  it('does not skip CI at the push comparison file limit', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      filename: `docs/page-${i}.md`,
    }));
    expect(await runFilter('push', { files })).toBe('true');
    expect(await runFilter('push', { files: files.slice(1) })).toBe('false');
  });

  it('defaults to CI without a comparable push base or comparison files', async () => {
    for (const before of ['', '0'.repeat(40)]) {
      expect(await runFilter('push', { before })).toBe('true');
    }
    expect(await runFilter('push', { files: undefined })).toBe('true');
    expect(await runFilter('push', { comparisonStatus: 'diverged' })).toBe(
      'true',
    );
    expect(await runFilter('workflow_dispatch')).toBe('true');
  });

  it('routes executable changes to existing checks and keeps required job identities', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    for (const job of [
      'changes',
      'test',
      'windows-sandbox-paths',
      'coverage',
    ]) {
      expect(workflow).toMatch(new RegExp(`^  ${job}:$`, 'm'));
    }
    for (const command of [
      'pnpm docs:scripts:check',
      'pnpm -r build-check',
      'pnpm test',
      'pnpm test:integration:api-contract',
    ]) {
      const step = workflow
        .split(/\n\s+- name:/)
        .find((part) =>
          part
            .split('\n')
            .some(
              (line) =>
                line.trim() === command || line.trim() === `run: ${command}`,
            ),
        );
      expect(step, command).toBeDefined();
      expect(step).toContain("needs.changes.outputs.run_ci == 'true'");
    }
    expect(workflow).not.toContain('pnpm docs:build');
    expect(workflow).not.toContain('pnpm -F docs-code build-check');
  });

  it('typechecks MDX snippet wiring without widening docs deployment eligibility', () => {
    const workflow = readFileSync(
      resolve(rootDir, '.github/workflows/docs.yml'),
      'utf8',
    );
    const normalized = workflow
      .split('\n')
      .map((line) => line.trim())
      .join('\n');
    expect(normalized).toContain(`on:
push:
branches: [main]
paths:
- "docs/**"
pull_request:
paths:
- "docs/**"
workflow_dispatch:`);
    expect(normalized).toContain(`deploy:
if: github.event_name == 'push' && github.ref == 'refs/heads/main'`);
    expect(normalized).toContain('permissions:\ncontents: read');
    expect(normalized).toContain('permissions:\npages: write\nid-token: write');
    for (const command of [
      'pnpm docs:scripts:check',
      'pnpm -F docs-code build-check',
    ]) {
      const step = workflow
        .split(/\n\s+- name:/)
        .find((part) => part.includes(`run: ${command}`));
      expect(step, command).toBeDefined();
      expect(step).not.toMatch(/^\s*if:/m);
      expect(workflow.indexOf(`run: ${command}`)).toBeGreaterThan(
        workflow.indexOf('run: pnpm build:ci'),
      );
      expect(workflow.indexOf(`run: ${command}`)).toBeLessThan(
        workflow.indexOf('run: pnpm docs:build'),
      );
    }
  });
});

type ChangedFile = { filename: string; previous_filename?: string };
type FilterOptions = {
  files?: ChangedFile[];
  changedFiles?: number;
  before?: string;
  comparisonStatus?: string;
  apiError?: boolean;
};

// Read the full YAML literal block, independent of JavaScript names or indentation width.
function classifierScript(): string {
  const lines = readFileSync(workflowPath, 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s*script: \|\s*$/.test(line));
  if (start < 0) throw new Error('Missing CI classifier script.');
  const indentation = lines[start].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indentation) break;
    body.push(line);
  }
  return body.join('\n');
}

async function runFilter(eventName: string, options: FilterOptions = {}) {
  const files =
    'files' in options ? options.files : [{ filename: 'README.md' }];
  const changedFiles =
    'changedFiles' in options ? options.changedFiles : files?.length;
  const outputs: Record<string, string> = {};
  const listFiles = () => {};
  const context = {
    eventName,
    repo: { owner: 'openai', repo: 'openai-agents-js' },
    payload: {
      pull_request: { number: 123, changed_files: changedFiles },
      before: options.before ?? 'a'.repeat(40),
      after: 'b'.repeat(40),
    },
  };
  await runInNewContext(`(async () => {${classifierScript()}\n})()`, {
    context,
    core: {
      info: () => {},
      warning: () => {},
      setOutput: (key: string, value: string) => {
        outputs[key] = value;
      },
    },
    github: {
      paginate: async (
        method: unknown,
        parameters: Record<string, unknown>,
      ) => {
        expect(method).toBe(listFiles);
        expect(parameters).toEqual({
          owner: 'openai',
          repo: 'openai-agents-js',
          pull_number: 123,
          per_page: 100,
        });
        if (options.apiError) throw new Error('File listing unavailable.');
        return files;
      },
      rest: {
        pulls: { listFiles },
        repos: {
          compareCommitsWithBasehead: async (
            parameters: Record<string, unknown>,
          ) => {
            expect(parameters).toEqual({
              owner: 'openai',
              repo: 'openai-agents-js',
              basehead: `${context.payload.before}...${context.payload.after}`,
            });
            if (options.apiError) throw new Error('Comparison unavailable.');
            return {
              data: { files, status: options.comparisonStatus ?? 'ahead' },
            };
          },
        },
      },
    },
  });
  return outputs.run_ci;
}
