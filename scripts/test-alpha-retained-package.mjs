import assert from 'node:assert/strict';
import { cp, mkdir, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyAlphaPackage } from './verify-alpha-package.mjs';
import { preflight, retainedAdapter } from './verify-alpha-retained-executor.mjs';
import { prepareHostedAdmission } from './retained-hosted-admission.mjs';

async function main() {
  const { values } = parseArgs({ options: {
    directory: { type: 'string' }, evidence: { type: 'string' },
  } });
  assert(values.directory && values.evidence,
    'Private test usage: node scripts/test-alpha-retained-package.mjs --directory <verified ordinary archives> --evidence <fresh private directory>');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_REPOSITORY, 'openai/openai-agents-js');
  assert.match(process.env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  const evidence = resolve(values.evidence);
  const ordinary = await realpath(resolve(values.directory));
  const temporary = await realpath(process.env.RUNNER_TEMP);
  assert(evidence.startsWith(temporary + sep));
  assert(!evidence.startsWith(ordinary + sep) && evidence !== ordinary);
  await mkdir(evidence, { mode: 0o700 });
  // Refusals retain zero invocations and do not touch ordinary archives/receipts.
  await preflight(evidence, undefined, process.env.GITHUB_SHA);
  const checkout = fileURLToPath(new URL('../', import.meta.url));
  const admission = await prepareHostedAdmission(checkout, evidence);
  delete process.env.GH_TOKEN;
  const archives = join(evidence, 'archives');
  await cp(ordinary, archives, { recursive: true, errorOnExist: true, force: false });
  const retainedExecutor = await retainedAdapter({ checkout, admission, evidence });
  await verifyAlphaPackage(archives, { retainedExecutor });
}

try { await main(); }
catch (error) {
  // Owned cleanup and private receipts have joined before restoring shutdown.
  if (error.parentSignal) process.kill(process.pid, error.parentSignal);
  throw error;
}
