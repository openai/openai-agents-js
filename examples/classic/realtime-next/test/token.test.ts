import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateToken } from '../generate-token.mjs';
import { getToken } from '../src/app/token';

test('token generation requires an operator key before requesting OpenAI', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('fetch should not run');
  });

  await assert.rejects(generateToken(), /Missing OPENAI_API_KEY/);
});

test('an operator can generate the example session token', async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'synthetic-operator-key';
  t.after(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(url, 'https://api.openai.com/v1/realtime/client_secrets');
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer synthetic-operator-key',
      );
      assert.deepEqual(JSON.parse(init?.body as string), {
        session: {
          type: 'realtime',
          model: 'gpt-realtime-2.1',
          tools: [
            {
              type: 'mcp',
              server_label: 'deepwiki',
              server_url: 'https://mcp.deepwiki.com/mcp',
              require_approval: 'always',
            },
            {
              type: 'mcp',
              server_label: 'dnd',
              server_url: 'https://dmcp-server.deno.dev/mcp',
              require_approval: 'always',
            },
          ],
        },
      });
      return Response.json({ value: 'synthetic-client-secret' });
    },
  );

  assert.equal(await generateToken(), 'synthetic-client-secret');
});

test('browser connection uses the operator-supplied secret', (t) => {
  const originalPrompt = globalThis.prompt;
  globalThis.prompt = () => 'synthetic-client-secret';
  t.after(() => {
    if (originalPrompt) {
      globalThis.prompt = originalPrompt;
    } else {
      Reflect.deleteProperty(globalThis, 'prompt');
    }
  });
  assert.equal(getToken(), 'synthetic-client-secret');
});

test('cancelling the browser prompt does not supply a secret', (t) => {
  const originalPrompt = globalThis.prompt;
  globalThis.prompt = () => null;
  t.after(() => {
    if (originalPrompt) {
      globalThis.prompt = originalPrompt;
    } else {
      Reflect.deleteProperty(globalThis, 'prompt');
    }
  });
  assert.equal(getToken(), null);
});
