import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { encryptedSessionStore } from '../../src/runtime/encrypted-thread-store';
import { fileSessionStore } from '../../src/runtime/file-thread-store';
import { ModelServer, message } from './fixtures/model-server';

const directories: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('restores native encrypted history and supplies it to the next model request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'encrypted-native-'));
  directories.push(directory);
  const server = new ModelServer([
    [message('SYNTHETIC_PRIVATE_REPLY')],
    [message('continued')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-encrypted-store-key',
  });
  const agent = new Agent({
    instructions: 'Answer briefly.',
    model: 'gpt-5',
    provider,
  });
  const options = { encryptionKey: Buffer.alloc(32, 41) };
  const first = await agent.session({
    storage: encryptedSessionStore(fileSessionStore(directory), options),
  });
  const id = first.id;
  try {
    expect(
      (await (await first.submit('SYNTHETIC_PRIVATE_PROMPT')).wait())
        .finalOutput,
    ).toBe('SYNTHETIC_PRIVATE_REPLY');
  } finally {
    await first.close();
  }
  expect(await readFile(join(directory, `${id}.json`), 'utf8')).not.toContain(
    'SYNTHETIC_PRIVATE',
  );
  const reopened = await agent.session({
    resume: id,
    storage: encryptedSessionStore(fileSessionStore(directory), options),
  });
  try {
    expect((await (await reopened.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
  } finally {
    await reopened.close();
  }
  expect(JSON.stringify(server.requests[1]?.input)).toContain(
    'SYNTHETIC_PRIVATE_PROMPT',
  );
  expect(JSON.stringify(server.requests[1]?.input)).toContain(
    'SYNTHETIC_PRIVATE_REPLY',
  );
  server.assertExhausted();
});
