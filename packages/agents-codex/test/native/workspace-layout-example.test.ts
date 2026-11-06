import { afterEach, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWorkspaceCatalog } from '../../../../examples/codex/workspace-layout';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('runs the catalog example with skill metadata but no implicit file or execution authority', async () => {
  const executor = await startPublicExecutor();
  try {
    const root = join(executor.cwd, 'workspace');
    const skill = join(root, 'skills', 'workspace_review');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: workspace_review\ndescription: CATALOG_METADATA_AMBER\n---\nRead only application-selected inputs when authorized.\n',
    );
    const files = [
      ['scripts', 'review.js', 'SCRIPT_BODY_COBALT'],
      ['memory', 'notes.md', 'MEMORY_BODY_JADE'],
      ['inputs', 'request.md', 'INPUT_BODY_CORAL'],
      ['outputs', 'README.md', 'OUTPUT_BODY_SILVER'],
    ] as const;
    for (const [directory, name, marker] of files) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, name), marker);
    }
    const server = new ModelServer([
      [message('workspace_review: CATALOG_METADATA_AMBER')],
    ]);
    const config = await server.config();
    const result = await runWorkspaceCatalog(
      'List the available skill names and descriptions.',
      { url: executor.url, cwd: root, headers: executor.headers },
      'fixture',
      {
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-workspace-catalog',
        supportsWebsockets: false,
      },
    );
    expect(result.finalOutput).toBe('workspace_review: CATALOG_METADATA_AMBER');
    expect(server.requests).toHaveLength(1);
    const firstRequest = JSON.stringify(server.requests[0]);
    expect(firstRequest).toContain('workspace_review');
    expect(firstRequest).toContain('CATALOG_METADATA_AMBER');
    for (const [, , marker] of files)
      expect(firstRequest).not.toContain(marker);
    expect(JSON.stringify(server.requests[0]?.tools ?? [])).not.toContain(
      'exec_command',
    );
    expect(
      executor.requests.filter((request) => request.method === 'process/start'),
    ).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await executor.close();
  }
}, 30_000);
