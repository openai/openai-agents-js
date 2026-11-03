/* global console, process */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  Agent,
  Environment,
  NativeError,
  NativeProvider,
  parseSessionState,
} from '@openai/agents';

const [phase, serialized] = process.argv.slice(2);
const options = JSON.parse(serialized);
const decisions = [];
// These are current application grants, supplied separately from conversation state.
const permitted =
  phase === 'initial' ? [options.produce, options.consume] : [options.consume];
const environment = new Environment({
  url: options.url,
  cwd: options.cwd,
  headers: options.headers,
  capabilityDirectories: [],
  tools: ['exec_command'],
  approval(_context, args) {
    const allowed = permitted.some((cmd) => isDeepStrictEqual(args, { cmd }));
    decisions.push({ args, allowed });
    return allowed;
  },
});
const provider = new NativeProvider({
  baseUrl: options.baseUrl,
  apiKey: 'synthetic-workspace-reuse',
  supportsWebsockets: false,
});
const agent = new Agent({
  instructions: 'Use only the application-selected workspace commands.',
  model: 'gpt-5',
  tools: [],
  provider,
});
let session;
try {
  const state =
    phase === 'initial'
      ? undefined
      : parseSessionState(await readFile(options.checkpoint, 'utf8'));
  session = await agent.session({ environment, state });
  if (phase === 'initial') {
    assert.equal(
      (await (await session.submit('Produce the selected report.')).wait())
        .finalOutput,
      'produced',
    );
    assert.equal(
      (await (await session.submit('Reuse that report.')).wait()).finalOutput,
      'reused',
    );
    await writeFile(
      options.checkpoint,
      JSON.stringify(await session.saveState()),
    );
  } else {
    // The exact command permitted by the previous host is not a current grant.
    await assert.rejects(
      (await session.submit('Try the former write command.')).wait(),
      NativeError,
    );
    assert.equal(
      (
        await (
          await session.submit(
            'Read the retained report with the current grant.',
          )
        ).wait()
      ).finalOutput,
      'reused after restart',
    );
  }
} finally {
  try {
    await session?.close();
  } finally {
    await provider.close();
  }
}
console.log(JSON.stringify({ pid: process.pid, phase, decisions }));
