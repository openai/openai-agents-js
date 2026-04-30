import { Runner } from '@openai/agents';
import {
  filesystem,
  Manifest,
  memory,
  SandboxAgent,
  shell,
  type SandboxSession,
} from '@openai/agents/sandbox';
import {
  UnixLocalSandboxClient,
  type UnixLocalSandboxSessionState,
} from '@openai/agents/sandbox/local';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const TASK_PROMPT =
  'Inspect the workspace, fix the invoice total bug in src/acme_metrics/report.mjs, run node --test, and summarize the fix.';

function buildManifest() {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content:
          '# Acme Metrics\n\nSmall demo package for validating invoice total formatting.\n',
      },
      'package.json': {
        type: 'file',
        content: `{
  "name": "acme-metrics",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
`,
      },
      'src/acme_metrics/report.mjs': {
        type: 'file',
        content: `export function formatInvoiceTotal(subtotal, taxRate) {
  const total = subtotal + taxRate;
  return \`$\${total.toFixed(2)}\`;
}
`,
      },
      'tests/report.test.mjs': {
        type: 'file',
        content: `import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInvoiceTotal } from '../src/acme_metrics/report.mjs';

test('formatInvoiceTotal applies the tax rate', () => {
  assert.equal(formatInvoiceTotal(100, 0.075), '$107.50');
});
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const phaseOneModel = getStringArg('--phase-one-model', 'gpt-5.4-mini');
  const phaseTwoModel = getStringArg('--phase-two-model', 'gpt-5.4');
  const manifest = buildManifest();
  const client = new UnixLocalSandboxClient();
  const session: SandboxSession<UnixLocalSandboxSessionState> =
    await client.create({ manifest });
  const agent = new SandboxAgent({
    name: 'Sandbox Memory Generation Demo',
    model,
    instructions:
      'Inspect files before editing, make minimal changes, and verify with node --test.',
    defaultManifest: manifest,
    capabilities: [
      filesystem(),
      shell(),
      memory({
        read: false,
        generate: {
          phaseOneModel,
          phaseTwoModel,
          extraPrompt:
            'Preserve exact verification commands, changed files, root causes, and durable user workflow preferences.',
        },
      }),
    ],
  });

  try {
    const runner = new Runner({ groupId: 'sandbox-memory-generation-example' });
    const result = await runner.run(agent, TASK_PROMPT, {
      maxTurns: 30,
      sandbox: { session },
    });

    await session.runPreStopHooks?.();

    const [rawMemories, memorySummary, handbook] = await Promise.all([
      readFile(
        join(session.state.workspaceRootPath, 'memories/raw_memories.md'),
        'utf8',
      ),
      readFile(
        join(session.state.workspaceRootPath, 'memories/memory_summary.md'),
        'utf8',
      ),
      readFile(join(session.state.workspaceRootPath, 'memories/MEMORY.md'), {
        encoding: 'utf8',
      }),
    ]);

    console.log('[run result]');
    console.log(result.finalOutput);
    console.log('\n[memories/raw_memories.md]');
    console.log(rawMemories.trim());
    console.log('\n[memories/memory_summary.md]');
    console.log(memorySummary.trim());
    console.log('\n[memories/MEMORY.md]');
    console.log(handbook.trim());
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
