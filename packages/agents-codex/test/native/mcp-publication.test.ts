import { expect, it } from 'vitest';
import { checkMcpPublication, HttpMCP, StdioMCP } from '../../src/runtime/mcp';

const selected = new StdioMCP({
  name: 'selected',
  tools: ['lookup'],
  command: process.execPath,
  lifetime: 'turn',
});
const persistent = new StdioMCP({
  name: 'persistent',
  tools: ['lookup'],
  command: process.execPath,
});
const http = new HttpMCP({
  name: 'http',
  tools: ['lookup'],
  url: 'https://example.invalid/mcp',
});
const connected = {
  accepted: true,
  ready: true,
  status: 'connected',
  listing_error: false,
  tools: ['lookup'],
};
const deferred = {
  accepted: true,
  ready: false,
  deferred_until_turn: true,
  status: null,
  listing_error: false,
  tools: [],
};
function publication(
  servers: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    result: {
      publication: 'published',
      ready: false,
      deferred_until_turn: true,
      policy_generation: '7',
      servers,
      ...overrides,
    },
  };
}

it('accepts a truthful mixed connected and turn-deferred publication', () => {
  expect(() =>
    checkMcpPublication(
      publication({ selected: deferred, persistent: connected }),
      [selected, persistent],
      7n,
    ),
  ).not.toThrow();
  expect(() =>
    checkMcpPublication(
      publication(
        { persistent: connected },
        { ready: true, deferred_until_turn: false },
      ),
      [persistent],
      7n,
    ),
  ).not.toThrow();
});

it.each([
  { status: 'connected' },
  { status: 'failed' },
  { status: 'starting' },
  { status: 'notStarted' },
  { status: 'cancelled' },
  { status: 'disabled' },
  { accepted: false },
  { ready: true },
  { listing_error: true },
  { tools: ['lookup'] },
  { tools: undefined },
  { deferred_until_turn: false },
  { status: undefined },
])('rejects an invalid deferred report %j', (invalid) => {
  expect(() =>
    checkMcpPublication(
      publication({ selected: { ...deferred, ...invalid } }),
      [selected],
      7n,
    ),
  ).toThrow();
});

it('rejects deferral for session stdio and HTTP descriptors', () => {
  for (const server of [persistent, http]) {
    expect(() =>
      checkMcpPublication(
        publication({ [server.name]: deferred }),
        [server],
        7n,
      ),
    ).toThrow();
  }
});

it.each([
  { tools: [] },
  { ready: false },
  { status: 'failed' },
  { listing_error: true },
  { accepted: false },
  { deferred_until_turn: true },
])('retains ordinary readiness and selected-tool checks %j', (invalid) => {
  expect(() =>
    checkMcpPublication(
      publication({
        selected: deferred,
        persistent: { ...connected, ...invalid },
      }),
      [selected, persistent],
      7n,
    ),
  ).toThrow();
});

it.each([
  { publication: 'rejected' },
  { publication: 'stale' },
  { policy_generation: '8' },
  { ready: true },
  { deferred_until_turn: false },
  { deferred_until_turn: undefined },
])('rejects inconsistent aggregate or stale publication %j', (invalid) => {
  expect(() =>
    checkMcpPublication(
      publication({ selected: deferred }, invalid),
      [selected],
      7n,
    ),
  ).toThrow();
});

it('rejects a deferred aggregate without a deferred descriptor', () => {
  expect(() =>
    checkMcpPublication(
      publication({ persistent: connected }),
      [persistent],
      7n,
    ),
  ).toThrow();
});
