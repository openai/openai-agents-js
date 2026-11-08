import { expect, it, vi } from 'vitest';
import { Session } from '../src/runtime/session';
import { HttpMCP } from '../src/runtime/mcp';
import { captureTools } from '../src/runtime/tools';
import type { Engine, NativeThread } from '../src/runtime/binding';

function fixture() {
  const descriptor = (tools: string[]) =>
    new HttpMCP({
      name: 'records',
      url: 'http://127.0.0.1/mcp',
      tools,
      activation: 'operation',
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
    _configure_manual_tools: vi.fn(),
    _replace_mcp_servers: publish,
    _replace_tools: vi.fn(async (generation: string) => generation),
  };
  const session = new Session(
    {} as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    { mcpTools: [descriptor(['lookup', 'other'])] },
    {},
  );
  return { session, publish, descriptor };
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
