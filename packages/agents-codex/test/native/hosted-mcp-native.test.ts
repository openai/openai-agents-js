import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  hostedMcp,
  type HostedMCPApprovalRequest,
} from '../../src';
import { jsonObject, type JsonObject } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const caller = { type: 'direct', fixture: { retained: false } };
function approval(id: string | null = 'mcpr_fixture'): JsonObject {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'mcp_approval_request',
      ...(id === null ? {} : { id }),
      server_label: 'docs',
      name: 'lookup',
      arguments: '{"key":"fixture"}',
      caller,
    },
  };
}

async function providerFor(server: ModelServer): Promise<NativeProvider> {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: jsonObject.parse(config['model_providers.fixture'])
      .base_url as string,
    apiKey: 'synthetic-mcp-fixture',
    supportsWebsockets: false,
  });
}

it('selects only the qualified server and preserves the omitted never default', async () => {
  const server = new ModelServer([[message('done')]]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({
    serverLabel: 'docs',
    serverUrl: 'https://docs.invalid/mcp',
  });
  const other = hostedMcp({
    serverLabel: 'other',
    serverUrl: 'https://other.invalid/mcp',
  });
  await using session = await new Agent({
    instructions: 'Use the configured server.',
    provider,
    tools: [docs, other],
  }).session();
  await session.update({ tools: [docs] });
  expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
    'done',
  );
  const tools = server.requests[0].tools as JsonObject[];
  expect(tools.filter((item) => item.type === 'mcp')).toEqual([
    {
      type: 'mcp',
      server_label: 'docs',
      server_url: 'https://docs.invalid/mcp',
      require_approval: 'never',
    },
  ]);
  expect(
    tools.some((item) => item.type === 'function' && item.name === 'docs'),
  ).toBe(false);
  server.assertExhausted();
});

it.each([true, false])(
  'replies through the captured approval and caller: %s',
  async (approve) => {
    const server = new ModelServer([[approval()], [message('done')]]);
    await using provider = await providerFor(server);
    const callback = vi.fn(
      ({
        requestId,
        serverLabel,
        name,
        arguments: raw,
        caller: observed,
      }: HostedMCPApprovalRequest) => {
        expect({ requestId, serverLabel, name, raw, observed }).toEqual({
          requestId: 'mcpr_fixture',
          serverLabel: 'docs',
          name: 'lookup',
          raw: '{"key":"fixture"}',
          observed: caller,
        });
        return { approve, reason: 'fixture decision' };
      },
    );
    const docs = hostedMcp({
      serverLabel: 'docs',
      serverUrl: 'https://docs.invalid/mcp',
      requireApproval: 'always',
      onApprovalRequest: callback,
    });
    expect(
      (
        await new Agent({
          instructions: 'Use the configured server.',
          provider,
          tools: [docs],
        }).run('lookup')
      ).finalOutput,
    ).toBe('done');
    expect(callback).toHaveBeenCalledTimes(1);
    const input = server.requests[1].input as JsonObject[];
    expect(
      input.find((item) => item.type === 'mcp_approval_response'),
    ).toMatchObject({
      approval_request_id: 'mcpr_fixture',
      approve,
      reason: 'fixture decision',
      caller,
    });
    server.assertExhausted();
  },
);

it('leaves a live manual grant usable after unsupported suspension', async () => {
  const server = new ModelServer([[approval()], [message('done')]]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({ serverLabel: 'docs', requireApproval: 'always' });
  await using session = await new Agent({
    instructions: 'Use the configured server.',
    provider,
    tools: [docs],
  }).session();
  const turn = await session.submit('lookup');
  const batch = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in batch)) throw new Error('Expected MCP approval');
  const request = docs.match(batch.requests[0]);
  if (!request) throw new Error('Expected captured MCP approval');
  expect(request.arguments.serverLabel).toBe('docs');
  await expect(session.suspend()).rejects.toThrow('requires a live reply');
  await session.respond(request.reply({ approve: true }));
  expect((await turn.wait()).finalOutput).toBe('done');
  server.assertExhausted();
});

it('fails promptly without an interaction handler', async () => {
  const server = new ModelServer([[approval()]]);
  await using provider = await providerFor(server);
  const docs = hostedMcp({ serverLabel: 'docs', requireApproval: 'always' });
  await expect(
    new Agent({
      instructions: 'Use the configured server.',
      provider,
      tools: [docs],
    }).run('lookup'),
  ).rejects.toBeInstanceOf(InteractionRequired);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
});
