import { run } from '@openai/agents';
import {
  filesystem,
  Manifest,
  memory,
  SandboxAgent,
  shell,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const FIRST_PROMPT =
  'Inspect the workspace, fix the invoice total bug in src/acme_metrics/report.mjs, run node --test, and update the existing memories/MEMORY.md plus memories/memory_summary.md files with the bug, root cause, changed file, and verification command.';
const SECOND_PROMPT =
  'Add a regression test for the previous bug in tests/invoice_regression.test.mjs, run node --test, and summarize how the memory helped.';

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
      'memories/MEMORY.md': {
        type: 'file',
        content: '# Workspace Memory\n\n',
      },
      'memories/memory_summary.md': {
        type: 'file',
        content: '# Memory Summary\n\n',
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const snapshotBaseDir = await mkdtemp(
    join(tmpdir(), 'openai-agents-sandbox-memory-snapshots-'),
  );
  const manifest = buildManifest();
  const client = new UnixLocalSandboxClient({
    snapshot: {
      type: 'local',
      baseDir: snapshotBaseDir,
    },
  });
  const initialSession = await client.create({ manifest });
  const resumableClient = client as {
    serializeSessionState: (
      state: typeof initialSession.state,
    ) => Promise<Record<string, unknown>>;
    deserializeSessionState: (
      state: Record<string, unknown>,
    ) => Promise<typeof initialSession.state>;
    resume: (
      state: typeof initialSession.state,
    ) => Promise<typeof initialSession>;
  };

  const agent = new SandboxAgent({
    name: 'Sandbox Workspace Memory Demo',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect files before answering, make minimal edits, verify with node --test, and keep durable workspace notes by updating the existing memories/MEMORY.md and memories/memory_summary.md files.',
    defaultManifest: manifest,
    capabilities: [filesystem(), shell(), memory({ generate: false })],
  });

  let resumedSession:
    | Awaited<ReturnType<typeof resumableClient.resume>>
    | undefined;

  try {
    const first = await run(agent, FIRST_PROMPT, {
      maxTurns: 30,
      sandbox: { session: initialSession },
    });

    const serializedState = await resumableClient.serializeSessionState(
      initialSession.state,
    );
    resumedSession = await resumableClient.resume(
      await resumableClient.deserializeSessionState(serializedState),
    );

    const second = await run(agent, SECOND_PROMPT, {
      maxTurns: 30,
      sandbox: { session: resumedSession },
    });
    const verification = await resumedSession.execCommand?.({
      cmd: 'node --test',
      yieldTimeMs: 1_500,
      maxOutputTokens: 600,
    });
    if (!verification?.includes('Process exited with code 0')) {
      throw new Error(`Expected node --test to pass:\n${verification}`);
    }
    if (!verification.includes('pass 2')) {
      throw new Error(
        `Expected node --test to discover 2 tests:\n${verification}`,
      );
    }

    const memoryText = await readFile(
      join(resumedSession.state.workspaceRootPath, 'memories/MEMORY.md'),
      'utf8',
    );

    console.log('[first run]');
    console.log(first.finalOutput);
    console.log('\n[second run]');
    console.log(second.finalOutput);
    console.log('\n[memories/MEMORY.md]');
    console.log(memoryText.trim());
    console.log('\n[verification]');
    console.log(verification);
  } finally {
    if (resumedSession) {
      await resumedSession.close?.().catch(() => {});
    }
    await initialSession.close?.().catch(() => {});
    await rm(snapshotBaseDir, { recursive: true, force: true }).catch(() => {});
  }
}

await runExampleMain(main);
