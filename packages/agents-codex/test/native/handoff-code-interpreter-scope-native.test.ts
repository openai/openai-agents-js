import { captureAgentProfiles } from '../../src/runtime/public-agent';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  codeInterpreter,
  parseSessionState,
  webSearch,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it('keeps CodeInterpreter container and output settings with the exact profile across cold restore and return', async () => {
  const standalone = webSearch({ route: 'standalone' });
  const standaloneTarget = new Agent({
    name: 'standalone_target',
    instructions: 'Keep common standalone search.',
    tools: [standalone, codeInterpreter({ container: { type: 'auto' } })],
  });
  const standaloneRoot = new Agent({
    instructions: 'Keep common standalone search.',
    tools: [standalone],
    handoffs: [standaloneTarget],
  });
  const captured = captureAgentProfiles(standaloneRoot);
  expect(
    captured.every((profile) => profile.scopedHostedSearch === undefined),
  ).toBe(true);
  expect(captured[1]!.scopedHostedCodeInterpreter).toHaveLength(1);
  const server = new ModelServer([
    [call('transfer_to_target', {}, { callId: 'code-scope-out' })],
    [
      {
        type: 'code_interpreter_call',
        id: 'provider-code-output',
        status: 'completed',
        container_id: 'cntr_synthetic',
        code: '2+2',
        outputs: [{ type: 'logs', logs: '4' }],
      },
      message('target complete'),
    ],
    [call('transfer_to_source', {}, { callId: 'code-scope-back' })],
    [message('source complete')],
  ]);
  await using provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-code-scope',
    supportsWebsockets: false,
  });
  let source: Agent<undefined, unknown>;
  const target = new Agent({
    name: 'target',
    instructions: 'Target owns provider code.',
    tools: [
      codeInterpreter({
        container: { type: 'auto', file_ids: ['file_synthetic_scope'] },
        includeOutputs: true,
      }),
    ],
    handoffs: [() => source],
  });
  source = new Agent({
    name: 'source',
    instructions: 'Source has no provider code.',
    provider,
    model: 'gpt-5.5',
    tools: [],
    handoffs: [target],
  });
  let state;
  {
    await using session = await source.session();
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'target complete',
    );
    expect(await session.getActiveAgent()).toBe(target);
    const serialized = JSON.stringify(await session.saveState());
    state = parseSessionState(serialized, {
      expectedSha256: createHash('sha256').update(serialized).digest('hex'),
    });
  }
  let changedSource: Agent<undefined, unknown>;
  const changedTarget = new Agent({
    name: 'target',
    instructions: 'Target owns provider code.',
    tools: [
      codeInterpreter({
        container: 'cntr_different_authority',
        includeOutputs: true,
      }),
    ],
    handoffs: [() => changedSource],
  });
  changedSource = new Agent({
    name: 'source',
    instructions: 'Source has no provider code.',
    provider,
    model: 'gpt-5.5',
    tools: [],
    handoffs: [changedTarget],
  });
  await expect(changedSource.session({ state })).rejects.toThrow(
    /declaration|captured|fingerprint|Agent/i,
  );
  expect(server.requests).toHaveLength(2);
  {
    await using restored = await source.session({ state });
    expect(await restored.getActiveAgent()).toBe(target);
    expect((await (await restored.submit('Return.')).wait()).finalOutput).toBe(
      'source complete',
    );
    expect(await restored.getActiveAgent()).toBe(source);
  }
  expect(server.requests).toHaveLength(4);
  const offered = (request: JsonObject) =>
    (request.tools as JsonObject[]).filter(
      (t) => t.type === 'code_interpreter',
    );
  const included = (request: JsonObject) =>
    (request.include as string[] | undefined)?.filter(
      (value) => value === 'code_interpreter_call.outputs',
    ) ?? [];
  for (const request of [server.requests[0]!, server.requests[3]!]) {
    expect(offered(request)).toEqual([]);
    expect(included(request)).toEqual([]);
  }
  for (const request of [server.requests[1]!, server.requests[2]!]) {
    expect(offered(request)).toEqual([
      {
        type: 'code_interpreter',
        container: { type: 'auto', file_ids: ['file_synthetic_scope'] },
      },
    ]);
    expect(included(request)).toEqual(['code_interpreter_call.outputs']);
  }
  server.assertExhausted();
}, 30000);
