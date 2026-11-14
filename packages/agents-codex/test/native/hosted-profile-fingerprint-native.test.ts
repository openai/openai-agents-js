import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  codeInterpreter,
  parseSessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it('pins hosted output includes while accepting current domain-secret values on trusted restore', async () => {
  const oldSecret = 'synthetic-old-domain-credential';
  const freshSecret = 'synthetic-fresh-domain-credential';
  const server = new ModelServer([
    [call('transfer_to_target', {}, { callId: 'secret-transfer' })],
    [message('target complete')],
    [message('fresh complete')],
  ]);
  await using provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-fingerprint',
    supportsWebsockets: false,
  });
  function graph(includeOutputs: boolean, secret: string) {
    const container = {
      type: 'auto' as const,
      file_ids: ['file_owned'],
      network_policy: {
        type: 'allowlist' as const,
        allowed_domains: ['example.invalid'],
        domain_secrets: [
          { domain: 'example.invalid', name: 'token', value: secret },
        ],
      },
    };
    const target = new Agent({
      name: 'target',
      instructions: 'Own provider code.',
      tools: [codeInterpreter({ container, includeOutputs })],
    });
    const root = new Agent({
      name: 'root',
      instructions: 'Transfer.',
      provider,
      model: 'gpt-5.5',
      tools: [],
      handoffs: [target],
    });
    return { root, target };
  }
  const original = graph(true, oldSecret);
  let state;
  {
    await using session = await original.root.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'target complete',
    );
    const serialized = JSON.stringify(await session.saveState());
    expect(serialized).not.toContain(oldSecret);
    state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  let unexpected;
  let refusal: unknown;
  try {
    unexpected = await graph(false, oldSecret).root.session({ state });
  } catch (error) {
    refusal = error;
  } finally {
    await unexpected?.close();
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(String(refusal)).toMatch(/declaration|captured|fingerprint|Agent/i);
  expect(server.requests).toHaveLength(2);
  const current = graph(true, freshSecret);
  {
    await using restored = await current.root.session({ state });
    expect(await restored.getActiveAgent()).toBe(current.target);
    expect(
      (await (await restored.submit('Continue.')).wait()).finalOutput,
    ).toBe('fresh complete');
    const serialized = JSON.stringify(await restored.saveState());
    expect(serialized).not.toContain(oldSecret);
    expect(serialized).not.toContain(freshSecret);
  }
  expect(server.requests).toHaveLength(3);
  const code = (index: number) =>
    (server.requests[index]!.tools as any[]).find(
      (tool) => tool.type === 'code_interpreter',
    );
  expect(code(1).container.network_policy.domain_secrets[0].value).toBe(
    oldSecret,
  );
  expect(code(2).container.network_policy.domain_secrets[0].value).toBe(
    freshSecret,
  );
  expect(server.requests[2]!.include).toContain(
    'code_interpreter_call.outputs',
  );
  server.assertExhausted();
}, 30000);
