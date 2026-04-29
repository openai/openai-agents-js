import { MemorySession, run } from '@openai/agents';
import {
  filesystem,
  Manifest,
  SandboxAgent,
  shell,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const GTM_TURN_1 =
  'Analyze data/leads.csv. Find one promising GTM segment, explain why, and write durable notes to memories/gtm/notes.md.';
const GTM_TURN_2 =
  'Using your previous GTM analysis, write a short outreach hypothesis to gtm_hypothesis.md and update memories/gtm/notes.md.';
const ENGINEERING_TURN =
  'Fix the invoice total bug in src/acme_metrics/report.mjs, run node --test, and write durable notes to memories/engineering/notes.md.';

function buildManifest() {
  return new Manifest({
    entries: {
      'data/leads.csv': {
        type: 'file',
        content: `account,segment,seats,trial_events,monthly_spend
Northstar Health,healthcare,240,98,18000
Beacon Retail,retail,75,18,4200
Apex Fintech,financial-services,180,76,13500
Summit Labs,healthcare,52,22,3900
`,
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
      memories: {
        type: 'dir',
        children: {
          gtm: {
            type: 'dir',
            children: {
              'notes.md': { type: 'file', content: '# GTM Notes\n\n' },
            },
          },
          engineering: {
            type: 'dir',
            children: {
              'notes.md': {
                type: 'file',
                content: '# Engineering Notes\n\n',
              },
            },
          },
        },
      },
    },
  });
}

function buildGtmAgent(model: string, manifest: Manifest) {
  return new SandboxAgent({
    name: 'GTM Analyst',
    model,
    instructions:
      'You are a GTM analyst. Inspect workspace data before answering, cite file paths, and maintain durable notes in memories/gtm/notes.md. Keep GTM notes separate from engineering notes.',
    defaultManifest: manifest,
    capabilities: [filesystem(), shell()],
  });
}

function buildEngineeringAgent(model: string, manifest: Manifest) {
  return new SandboxAgent({
    name: 'Engineering Fixer',
    model,
    instructions:
      'You are an engineer. Inspect files before editing, make minimal changes, verify with node --test, and maintain durable notes in memories/engineering/notes.md. Keep engineering notes separate from GTM notes.',
    defaultManifest: manifest,
    capabilities: [filesystem(), shell()],
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const manifest = buildManifest();
  const client = new UnixLocalSandboxClient();
  const session = await client.create(manifest);
  const gtmAgent = buildGtmAgent(model, manifest);
  const engineeringAgent = buildEngineeringAgent(model, manifest);
  const gtmConversation = new MemorySession({
    sessionId: 'sandbox-gtm-memory-example',
  });
  const engineeringConversation = new MemorySession({
    sessionId: 'sandbox-engineering-memory-example',
  });

  try {
    const gtmFirst = await run(gtmAgent, GTM_TURN_1, {
      maxTurns: 18,
      sandbox: { session },
      session: gtmConversation,
    });
    const gtmSecond = await run(gtmAgent, GTM_TURN_2, {
      maxTurns: 18,
      sandbox: { session },
      session: gtmConversation,
    });
    const engineering = await run(engineeringAgent, ENGINEERING_TURN, {
      maxTurns: 30,
      sandbox: { session },
      session: engineeringConversation,
    });

    const verification = await session.execCommand?.({
      cmd: 'node --test',
      yieldTimeMs: 1_500,
      maxOutputTokens: 600,
    });
    if (!verification?.includes('Process exited with code 0')) {
      throw new Error(`Expected node --test to pass:\n${verification}`);
    }
    if (!verification.includes('pass 1')) {
      throw new Error(
        `Expected node --test to discover 1 test:\n${verification}`,
      );
    }

    const gtmMemory = await readFile(
      join(session.state.workspaceRootPath, 'memories/gtm/notes.md'),
      'utf8',
    );
    const engineeringMemory = await readFile(
      join(session.state.workspaceRootPath, 'memories/engineering/notes.md'),
      'utf8',
    );

    console.log('\n[gtm turn 1]');
    console.log(gtmFirst.finalOutput);
    console.log('\n[gtm turn 2]');
    console.log(gtmSecond.finalOutput);
    console.log('\n[engineering]');
    console.log(engineering.finalOutput);
    console.log('\n[memories/gtm/notes.md]');
    console.log(gtmMemory.trim());
    console.log('\n[memories/engineering/notes.md]');
    console.log(engineeringMemory.trim());
    console.log('\n[verification]');
    console.log(verification);
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
