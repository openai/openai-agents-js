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
  ShellToolSkillReference,
  withTrace,
} from '@openai/agents';
import OpenAI, { toFile } from 'openai';

async function main() {
  const skillReference = await resolveSkillReference(
    new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  );

  await withTrace('container-shell-tool-example', async () => {
    const agent1 = new Agent({
      name: 'Container Shell Agent',
      model: 'gpt-5.2',
      modelSettings: { reasoning: { effort: 'low' } },
      instructions: 'Use the available container to answer user requests.',
      tools: [
        shellTool({
          environment: {
            // container_auto creates a new container with the skill
            type: 'container_auto',
            networkPolicy: { type: 'disabled' },
            skills: [
              {
                type: 'skill_reference',
                skillId: skillReference.skillId,
                version: skillReference.version,
              },
            ],
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
            // using a container that already exists
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

const SKILL_BUNDLE_NAME = 'csv-workbench';
const SKILL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skills',
  SKILL_BUNDLE_NAME,
);

async function resolveSkillReference(
  client: OpenAI,
): Promise<ShellToolSkillReference> {
  try {
    // This is a demo skill available for SDK maintainers
    const defaultReference: ShellToolSkillReference = {
      type: 'skill_reference',
      skillId: 'skill_698bbe879adc81918725cbc69dcae7960bc5613dadaed377',
      version: '1',
    };
    await assertSkillUsableInResponses(client, defaultReference);
    console.log(
      `Using default skill: ${defaultReference.skillId} (version ${defaultReference.version})`,
    );
    return defaultReference;
  } catch (_error) {
    const created = await createDemoSkill(client);
    console.log(
      `Created fallback skill: ${created.skillId} (version ${created.version})`,
    );
    return created;
  }
}

/**
 * Creates and uploads the demo skill bundle. This can take a while because
 * file upload and skill propagation are asynchronous.
 */
async function createDemoSkill(
  client: OpenAI,
): Promise<ShellToolSkillReference> {
  const bundle = await buildSkillZipBundle();
  const uploadedBundle = await toFile(bundle, `${SKILL_BUNDLE_NAME}.zip`, {
    type: 'application/zip',
  });

  const skill = await client.skills.create({
    files: uploadedBundle,
  });
  if (!skill.default_version) {
    throw new Error(
      `Skill ${skill.id} did not return a default version after upload.`,
    );
  }
  const reference: ShellToolSkillReference = {
    type: 'skill_reference',
    skillId: skill.id,
    version: skill.default_version,
  };
  await waitForSkillUsableInResponses(client, reference);
  return reference;
}

function isSkillVersionNotFoundError(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    error?: { message?: string };
  };
  return (
    candidate?.status === 404 &&
    typeof candidate.error?.message === 'string' &&
    candidate.error.message.includes('Skill version')
  );
}

async function assertSkillUsableInResponses(
  client: OpenAI,
  reference: ShellToolSkillReference,
): Promise<void> {
  await client.responses.create({
    model: 'gpt-5.2',
    reasoning: { effort: 'none' },
    input: 'Reply with exactly "ready".',
    max_output_tokens: 16,
    store: false,
    tool_choice: 'none',
    tools: [
      {
        type: 'shell',
        environment: {
          type: 'container_auto',
          skills: [
            {
              type: 'skill_reference',
              skill_id: reference.skillId,
              version: reference.version,
            },
          ],
        },
      },
    ],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSkillUsableInResponses(
  client: OpenAI,
  reference: ShellToolSkillReference,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      await assertSkillUsableInResponses(client, reference);
      return;
    } catch (error) {
      if (!isSkillVersionNotFoundError(error)) {
        throw error;
      }
      await sleep(1000);
    }
  }
  throw new Error(
    `Timed out waiting for skill ${reference.skillId} version ${reference.version} to be usable in responses.`,
  );
}

const execFileAsync = promisify(execFile);

async function buildSkillZipBundle(): Promise<Buffer> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'agents-skill-'));
  const zipPath = path.join(tempDir, `${SKILL_BUNDLE_NAME}.zip`);
  try {
    await execFileAsync('zip', ['-rq', zipPath, SKILL_BUNDLE_NAME], {
      cwd: path.dirname(SKILL_DIR),
    });
    return await readFile(zipPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'The `zip` command is required to build the skill bundle for this example.',
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
