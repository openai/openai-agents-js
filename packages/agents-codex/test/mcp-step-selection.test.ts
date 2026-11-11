import { expect, it } from 'vitest';
import { Session } from '../src/runtime/session';

it('resolves a large captured MCP roster with linear reads and preserves its ceiling', () => {
  const count = 256;
  let reads = 0;
  const raw = Array.from({ length: count }, (_, index) => `leaf_${index}`);
  const tools = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const namespace = 'mcp__docs';
  const defaults = raw.map((name) => ({ name, namespace }));
  const candidates = raw.map((name) => ({ name: `native_${name}`, namespace }));
  // This owner-local probe controls the captured native callback payload;
  // public native tests separately exercise descriptor and peer admission.
  const session = Object.create(Session.prototype) as any;
  Object.defineProperties(session, {
    options: { value: { agentGraph: true } },
    threadOptions: { value: {} },
    hasOperationMcp: { value: false },
    messageProfile: { value: () => ({ profile_id: 'source', epoch: 0n }) },
    profileKey: { value: () => 'source' },
    profileStepMcp: {
      value: new Map([['source', [{ name: 'docs', tools }]]]),
    },
  });
  const owner = { clientSearchCatalogKeys: new Set<string>() };
  const event = {
    msg: {
      thread: 'fixture',
      generation: '1',
      candidates,
      defaults: candidates,
      mcp_names: raw.map((tool, index) => ({
        server: 'docs',
        tool,
        namespace,
        name: candidates[index]!.name,
      })),
    },
  };
  const catalog = { generation: 1, tools: [] };
  expect(
    session.selectedStepNames(owner, event, undefined, defaults, catalog),
  ).toEqual(candidates);
  expect(reads).toBeLessThan(count * 12);
  reads = 0;
  expect(() =>
    session.selectedStepNames(
      owner,
      event,
      [{ kind: 'tool_ref', ...defaults.at(-1)! }],
      defaults.slice(0, -1),
      catalog,
    ),
  ).toThrow('beforeStep may only narrow the operation tools');
  expect(reads).toBeLessThan(count * 12);
});
