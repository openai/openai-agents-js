import { expect, it } from 'vitest';
import { z } from 'zod';
import { Handoff } from '../src/runtime/handoffs';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { captureTools, tool } from '../src/runtime/tools';

it('captures an unnamed target and a single callback with its declared schema', () => {
  const route = tool({
    name: 'route_issue',
    description: 'Issue routing',
    parameters: z.object({ ticket: z.number() }),
    execute: ({ ticket }) => `ticket=${ticket}`,
  });
  const target = new Agent({ instructions: 'Resolve the issue' });
  const transfer = new Handoff(target, route);
  const source = new Agent({
    instructions: 'Route',
    tools: [route],
    handoffs: [transfer, transfer],
  });
  const profiles = captureAgentProfiles(source);
  expect(source.tools).toHaveLength(1);
  expect(profiles).toHaveLength(2);
  expect({ ...profiles[0].handoffs }).toEqual({ route_issue: 'agent_1' });
  expect(Object.keys(profiles[0].handoffCallbacks ?? {})).toEqual([
    'route_issue',
  ]);
  expect(profiles[1].agent).toBe(target);
  const catalog = captureTools(profiles[0].callbackTools!);
  const [spec] = JSON.parse(catalog.specsJson);
  expect(spec.name).toBe('route_issue');
  expect(spec.description).toBe('Issue routing');
  expect(spec.inputSchema.properties.ticket.type).toBe('number');
  expect(Object.isFrozen(transfer)).toBe(true);
});

it.each([
  [{ needsApproval: true }, 'without a managed approval'],
  [{ finishTurn: true }, 'cannot finish the turn'],
  [{ namespace: 'other' }, 'default function namespace'],
] as const)(
  'rejects incompatible transfer callback options %o',
  (options, message) => {
    const route = tool({
      name: 'route',
      parameters: z.object({ ticket: z.number() }),
      execute: ({ ticket }) => String(ticket),
      ...options,
    });
    expect(
      () => new Handoff(new Agent({ instructions: 'Resolve' }), route),
    ).toThrow(message);
  },
);

it('retains the existing graph output wire requirement', () => {
  const route = tool({
    name: 'route',
    parameters: z.object({}),
    execute: () => 'routed',
  });
  const target = new Agent({ instructions: 'Number', outputType: z.number() });
  const source = new Agent({
    instructions: 'Text',
    handoffs: [new Handoff(target, route) as never],
  });
  expect(() => captureAgentProfiles(source)).toThrow('share output mode');
});

it('retains the generated plain handoff name without a callback', () => {
  const source = new Agent({
    instructions: 'Route',
    handoffs: [new Agent({ instructions: 'Resolve', name: 'Billing' })],
  });
  const [profile] = captureAgentProfiles(source);
  expect({ ...profile.handoffs }).toEqual({ transfer_to_billing: 'agent_1' });
  expect({ ...profile.handoffCallbacks }).toEqual({});
  expect(source.tools).toHaveLength(0);
});

it('captures two callbacks to the same ordinary target without duplicating the target profile', () => {
  const target = new Agent({ name: 'shared', instructions: 'Resolve.' });
  const first = new Handoff(
    target,
    tool({
      name: 'route_first',
      parameters: z.object({}),
      execute: () => 'first',
    }),
  );
  const second = new Handoff(
    target,
    tool({
      name: 'route_second',
      parameters: z.object({}),
      execute: () => 'second',
    }),
  );
  const source = new Agent({
    instructions: 'Route.',
    handoffs: [target, first, second, first],
  });
  const profiles = captureAgentProfiles(source);
  expect(profiles).toHaveLength(2);
  expect({ ...profiles[0].handoffs }).toEqual({
    transfer_to_shared: 'agent_1',
    route_first: 'agent_1',
    route_second: 'agent_1',
  });
  expect({ ...profiles[0].handoffCallbacks }).toEqual({
    route_first: 0,
    route_second: 1,
  });
});
