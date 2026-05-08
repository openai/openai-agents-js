import { run, type RunItem } from '@openai/agents';
import {
  Capabilities,
  Manifest,
  SandboxAgent,
  skills,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const VERIFICATION_FILE = 'verification/capabilities.txt';
const QUADRANTS_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAANklEQVR4nO3OsREAMAwCMUbP5nZ2oHAj7r5GmWSa8soAAAAAAAAAzgHl/1+qAAAAAAAAAM4BC4gseHlri/BJAAAAAElFTkSuQmCC',
    'base64',
  ),
);

function getToolNames(items: RunItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }

    const rawItem = item.rawItem as { name?: unknown; type?: unknown };
    if (typeof rawItem.name === 'string') {
      return [rawItem.name];
    }
    return rawItem.type === 'apply_patch_call' ? ['apply_patch'] : [];
  });
}

async function writeSkill(skillsRoot: string): Promise<void> {
  const skillDir = join(skillsRoot, 'capability-proof');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    `---
name: capability-proof
description: Verifies that the sandbox skills capability can lazy-load local instructions.
---

# Capability Proof

When loaded, use these exact verification values:
- skill_loaded=true
- codename=atlas
- note_source=filesystem
- image_verified=true
`,
    'utf8',
  );
}

function buildManifest(skillsRoot: string) {
  return new Manifest({
    extraPathGrants: [{ path: skillsRoot, readOnly: true }],
    entries: {
      'README.md': {
        type: 'file',
        content: `# Capability Smoke Workspace

This workspace is used to verify sandbox capabilities end to end.
Project code name: atlas.
`,
      },
      'notes/input.txt': {
        type: 'file',
        content: 'source=filesystem\n',
      },
      'examples/quadrants.png': {
        type: 'file',
        content: QUADRANTS_PNG,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const tempDir = await mkdtemp(join(tmpdir(), 'agents-sandbox-skills-'));
  const skillsRoot = join(tempDir, 'skills');
  await writeSkill(skillsRoot);

  const manifest = buildManifest(skillsRoot);
  const client = new UnixLocalSandboxClient();
  const session = await client.create(manifest);
  const agent = new SandboxAgent({
    name: 'Sandbox Capabilities Smoke',
    model,
    instructions: `Run the inspection phase of this sandbox capability smoke test, then answer with "capability inspection complete".

Follow this sequence:
1. Inspect the workspace root.
2. Read README.md and notes/input.txt.
3. Use view_image on examples/quadrants.png.
4. Load and use the $capability-proof skill.

Use relative paths because the shell starts in the workspace root.`,
    defaultManifest: manifest,
    capabilities: [
      ...Capabilities.default(),
      skills({
        lazyFrom: {
          source: {
            type: 'local_dir',
            src: skillsRoot,
          },
          index: [
            {
              name: 'capability-proof',
              description:
                'Verifies lazy-loaded sandbox skill instructions in the capability smoke example.',
            },
          ],
        },
      }),
    ],
    modelSettings: {
      toolChoice: 'required',
    },
  });
  const patchAgent = new SandboxAgent({
    name: 'Sandbox Capabilities Patch Smoke',
    model,
    instructions: `Use apply_patch for the requested filesystem changes. Do not create or delete files with shell redirection, printf, tee, cat, Python, or Node.`,
    defaultManifest: manifest,
    capabilities: Capabilities.default(),
    modelSettings: {
      toolChoice: 'apply_patch',
    },
  });

  try {
    const inspectionResult = await run(
      agent,
      'Run the capability smoke test now.',
      {
        maxTurns: 18,
        sandbox: { session },
      },
    );
    const patchResult = await run(
      patchAgent,
      `Call apply_patch exactly once with a structured create_file operation for ${VERIFICATION_FILE}. The file content must be exactly:
skill_loaded=true
codename=atlas
note_source=filesystem
image_verified=true

After that apply_patch call succeeds, answer with "capability smoke complete" without calling any more tools.`,
      {
        maxTurns: 4,
        sandbox: { session },
      },
    );
    const toolNames = [
      ...getToolNames(inspectionResult.newItems),
      ...getToolNames(patchResult.newItems),
    ];
    for (const expected of [
      'exec_command',
      'view_image',
      'load_skill',
      'apply_patch',
    ]) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Expected ${expected}, saw: ${toolNames.join(', ')}`);
      }
    }

    const verification = await readFile(
      join(session.state.workspaceRootPath, VERIFICATION_FILE),
      'utf8',
    );
    if (!verification.includes('image_verified=true')) {
      throw new Error(`Verification file was incomplete:\n${verification}`);
    }

    console.log('=== Final summary ===');
    console.log('final_output:', patchResult.finalOutput);
    console.log(`tool_calls: ${toolNames.join(', ')}`);
    console.log(`${VERIFICATION_FILE}:`);
    process.stdout.write(verification);
    if (!verification.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } finally {
    await session.close?.().catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

await runExampleMain(main);
