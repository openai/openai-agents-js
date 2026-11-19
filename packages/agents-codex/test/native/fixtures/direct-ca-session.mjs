import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { Agent, NativeProvider } from '@openai/agents-codex';
import { ScriptedModel } from '@openai/agents-codex/testing';

const [directory, urlA, urlB] = process.argv.slice(2);
const active = process.env.CODEX_CA_CERTIFICATE;
async function turn(target) {
  const provider = new NativeProvider(
    typeof target === 'string'
      ? {
          apiKey: 'synthetic-ca-test',
          baseUrl: target,
          supportsWebsockets: false,
          requestMaxRetries: 0,
          streamMaxRetries: 0,
        }
      : { modelBackend: target },
  );
  try {
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer directly.',
      provider,
    });
    const session = await agent.session();
    try {
      return (
        await (await session.submit('Which test server answered?')).wait()
      ).finalOutput;
    } finally {
      await session.close();
    }
  } finally {
    await provider.close();
  }
}

await copyFile(join(directory, 'a/ca.pem'), active);
assert.equal(await turn(urlA), 'a');
await writeFile(
  active,
  execFileSync('openssl', [
    'x509',
    '-in',
    join(directory, 'b/ca.pem'),
    '-trustout',
    '-addtrust',
    'serverAuth',
  ]),
);
assert.equal(await turn(urlB), 'b');
await assert.rejects(turn(urlA), /TLS certificate verification/i);
await writeFile(active, 'not a certificate');
await assert.rejects(turn(urlB));
await unlink(active);
await assert.rejects(turn(urlB));
// No network or trust store is needed to fulfill a scripted turn.
const local = new ScriptedModel([
  {
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'msg_local',
        content: [
          { type: 'output_text', text: 'local answer', annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
]);
assert.equal(await turn(local), 'local answer');
await copyFile(join(directory, 'a/ca.pem'), active);
assert.equal(await turn(urlA), 'a');

// A combined CA file may contain other PEM entries; neither can grant trust.
await writeFile(
  active,
  [
    await readFile(join(directory, 'a/ca.pem')),
    await readFile(join(directory, 'b/ca.pem')),
    await readFile(join(directory, 'a/ca.key')),
    '-----BEGIN X509 CRL-----\nMIIC\n-----END X509 CRL-----',
  ].join('\n'),
);
assert.deepEqual(await Promise.all([turn(urlA), turn(urlB)]), ['a', 'b']);
