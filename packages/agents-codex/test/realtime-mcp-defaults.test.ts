import { expect, it, vi } from 'vitest';
import { Session } from '../src/runtime/session';
import { HttpMCP, StdioMCP } from '../src/runtime/mcp';
import { captureTools } from '../src/runtime/tools';
import type { Engine, NativeThread } from '../src/runtime/binding';

function fixture(
  activation: 'session' | 'operation' = 'operation',
  openingTools = ['lookup', 'other'],
) {
  const descriptor = (tools: string[]) =>
    new HttpMCP({
      name: 'records',
      url: 'http://127.0.0.1/mcp',
      tools,
      activation,
    });
  const publish = vi.fn(async (raw: string, policies: string) => {
    const servers = JSON.parse(raw);
    return JSON.stringify({
      result: {
        publication: 'published',
        ready: true,
        policy_generation: String(JSON.parse(policies).generation),
        servers: Object.fromEntries(
          Object.entries(servers).map(([name, value]) => {
            const server = value as {
              enabled: boolean;
              enabled_tools: string[];
            };
            return [
              name,
              {
                accepted: true,
                ready: true,
                status: server.enabled !== false ? 'connected' : 'disabled',
                listing_error: false,
                tools: server.enabled !== false ? server.enabled_tools : [],
              },
            ];
          }),
        ),
      },
    });
  });
  const native = {
    id: 'root',
    call: vi.fn(async (_operation: string, _params: string) => '{}'),
    _configure_manual_tools: vi.fn(),
    _replace_mcp_servers: publish,
    _replace_tools: vi.fn(async (generation: string) => generation),
  };
  const session = new Session(
    {} as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    { mcpTools: [descriptor(openingTools)] },
    {},
  );
  return { session, publish, descriptor, native };
}

it('promotes inherited operation MCP defaults once without a native model turn', async () => {
  const { session, publish } = fixture();
  await session._prepareRealtimeMcp();
  const config = JSON.parse(publish.mock.calls[0][0]);
  expect(config.records.enabled).not.toBe(false);
  expect(config.records.enabled_tools).toEqual(['lookup', 'other']);
  await session._prepareRealtimeMcp();
  expect(publish).toHaveBeenCalledOnce();
});

it('voice promotion preserves the accepted default MCP subset', async () => {
  const { session, publish, descriptor } = fixture();
  await session.update({ tools: [descriptor(['lookup'])] });
  publish.mockClear();
  await session._prepareRealtimeMcp();
  const config = JSON.parse(publish.mock.calls[0][0]);
  expect(config.records.enabled).not.toBe(false);
  expect(config.records.enabled_tools).toEqual(['lookup']);
});

it('voice promotion keeps cleared MCP defaults disabled', async () => {
  const { session, publish } = fixture();
  await session.update({ tools: [] });
  publish.mockClear();
  await session._prepareRealtimeMcp();
  expect(publish).not.toHaveBeenCalled();
});

it.each(['session', 'operation'] as const)(
  'rejects a different raw MCP name with the same projection (%s activation)',
  async (activation) => {
    const { session, publish, descriptor } = fixture(activation, [
      'find-record',
    ]);
    await expect(
      session.update({ tools: [descriptor(['find_record'])] }),
    ).rejects.toThrow('Updated MCP raw identities');
    expect(publish).not.toHaveBeenCalled();
  },
);

it.each(['session', 'operation'] as const)(
  'retains opening raw names after narrowing the default selection (%s activation)',
  async (activation) => {
    const { session, publish, descriptor } = fixture(activation, [
      'find-record',
      'other',
    ]);
    await session.update({ tools: [descriptor(['other'])] });
    await session.update({ tools: [descriptor(['find-record'])] });
    expect(
      JSON.parse(publish.mock.calls.at(-1)![0]).records.enabled_tools,
    ).toEqual(['find-record']);
  },
);

it.each(['session', 'operation'] as const)(
  'retains activation restrictions on same-name replacements (%s activation)',
  async (activation) => {
    const { session, publish } = fixture(activation);
    await expect(
      session.update({
        tools: [
          new HttpMCP({
            name: 'records',
            url: 'http://127.0.0.1/replacement',
            tools: ['lookup'],
            activation: activation === 'session' ? 'operation' : 'session',
          }),
        ],
      }),
    ).rejects.toThrow('activation must match');
    expect(publish).not.toHaveBeenCalled();
  },
);

it('allows eager same-name transport replacement without adding operation-only restrictions', async () => {
  const { session, publish } = fixture('session');
  await session.update({
    tools: [
      new StdioMCP({
        name: 'records',
        command: '/synthetic/mcp',
        tools: ['lookup'],
        location: 'host',
      }),
    ],
  });
  expect(JSON.parse(publish.mock.calls[0][0]).records.command).toBe(
    '/synthetic/mcp',
  );
});

it('rejects replacing an operation MCP binding with a stdio binding', async () => {
  const { session, publish } = fixture();
  await expect(
    session.update({
      tools: [
        new StdioMCP({
          name: 'records',
          command: '/synthetic/mcp',
          tools: ['lookup'],
          location: 'host',
        }),
      ],
    }),
  ).rejects.toThrow('activation must match');
  expect(publish).not.toHaveBeenCalled();
});

it('SIP configuration promotes inherited MCP defaults before native config capture', async () => {
  const { session, publish, native } = fixture();
  native.call.mockImplementationOnce(async (operation) => {
    expect(operation).toBe('realtime_conversation_config_sdk');
    expect(publish).toHaveBeenCalledOnce();
    const config = JSON.parse(publish.mock.calls[0][0]);
    expect(config.records.enabled).not.toBe(false);
    expect(config.records.enabled_tools).toEqual(['lookup', 'other']);
    return '{}';
  });
  await expect(session.buildRealtimeSipConfig()).resolves.toEqual({});
  expect(native.call).toHaveBeenCalledOnce();
});

it('explicit SIP tools skip inherited MCP preparation just as connection does', async () => {
  const { session, publish } = fixture();
  await session.buildRealtimeSipConfig({ tools: [] });
  expect(publish).not.toHaveBeenCalled();
});
