import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  Agent,
  run,
  shellTool,
  ShellToolInlineSkill,
  withTrace,
} from '@openai/agents';

const SKILL_BUNDLE_NAME = 'csv-workbench';
const SKILL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skills',
  SKILL_BUNDLE_NAME,
);

async function main() {
  const inlineSkill = await buildInlineSkill();

  await withTrace('container-shell-inline-skill-example', async () => {
    const agent1 = new Agent({
      name: 'Container Shell Agent (Inline Skill)',
      model: 'gpt-5.2',
      modelSettings: { reasoning: { effort: 'low' } },
      instructions:
        'Use the available container skill to answer user requests.',
      tools: [
        shellTool({
          environment: {
            // container_auto creates a new container and mounts the inline skill.
            type: 'container_auto',
            networkPolicy: { type: 'disabled' },
            skills: [inlineSkill],
          },
        }),
      ],
    });

    const result1 = await run(
      agent1,
      'Use the csv-workbench skill. Create /mnt/data/orders.csv with columns id,region,amount,status and at least 6 rows. Then report total amount by region and count failed orders.',
    );
    console.log(`Agent: ${result1.finalOutput}`);

    const containerId = getContainerIdFromShellItems(result1.rawResponses);

    const agent2 = new Agent({
      name: 'Container Reference Shell Agent',
      model: 'gpt-5.2-codex',
      modelSettings: { reasoning: { effort: 'low' } },
      instructions: 'Reuse the existing shell container and answer concisely.',
      tools: [
        shellTool({
          environment: {
            // using a container that already exists.
            type: 'container_reference',
            containerId,
          },
        }),
      ],
    });
    const result2 = await run(
      agent2,
      'Run `ls -la /mnt/data`, then summarize in one sentence.',
    );
    console.log(`Agent (container reuse): ${result2.finalOutput}`);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractContainerId(item: Record<string, unknown>): string | undefined {
  const providerData = asRecord(item.providerData);
  const environment = asRecord(item.environment);
  const providerEnvironment = asRecord(providerData?.environment);
  const containerId =
    item.container_id ??
    item.containerId ??
    environment?.container_id ??
    environment?.containerId ??
    providerData?.container_id ??
    providerData?.containerId ??
    providerEnvironment?.container_id ??
    providerEnvironment?.containerId;
  return typeof containerId === 'string' && containerId.length > 0
    ? containerId
    : undefined;
}

function getContainerIdFromShellItems(
  rawResponses: Array<{ output: unknown[] }>,
): string {
  for (const response of rawResponses) {
    for (const outputItem of response.output) {
      const outputRecord = asRecord(outputItem);
      if (
        outputRecord?.type !== 'shell_call' &&
        outputRecord?.type !== 'shell_call_output'
      ) {
        continue;
      }
      const containerId = extractContainerId(outputRecord);
      if (containerId) {
        return containerId;
      }
    }
  }

  throw new Error('Container ID was not returned in shell_call items.');
}

async function buildInlineSkill(): Promise<ShellToolInlineSkill> {
  const bundle = await buildSkillZipBundle();

  return {
    type: 'inline',
    name: SKILL_BUNDLE_NAME,
    description:
      'Analyze CSV files in /mnt/data and return concise numeric summaries.',
    source: {
      type: 'base64',
      mediaType: 'application/zip',
      data: bundle.toString('base64'),
    },
  };
}

const execFileAsync = promisify(execFile);

async function buildSkillZipBundle(): Promise<Buffer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'agents-inline-skill-'));
  const zipPath = path.join(tempDir, `${SKILL_BUNDLE_NAME}.zip`);
  try {
    await execFileAsync('zip', ['-rq', zipPath, SKILL_BUNDLE_NAME], {
      cwd: path.dirname(SKILL_DIR),
    });
    return await readFile(zipPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'The `zip` command is required to build the inline skill bundle for this example.',
      );
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
