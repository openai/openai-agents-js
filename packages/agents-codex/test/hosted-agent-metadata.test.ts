import { expect, it } from 'vitest';
import { getHostedAgentMetadata } from '../src';
import { bindHostedAgentMetadata } from '../src/runtime/hosted-agent-metadata';
import {
  projectResponseFactRecord,
  summarizeResponseFactRecord,
} from '../src/runtime/response-facts';
it('reads only finite attribution from a provider item and its public wrapper', () => {
  const item = {
    agent: { agent_name: '/worker', namespace: 'untrusted' },
    phase: 'analysis',
    text: 'private',
  };
  expect(getHostedAgentMetadata(item)).toEqual({
    agentName: '/worker',
    phase: 'analysis',
  });
  expect(getHostedAgentMetadata({ providerData: item })).toEqual({
    agentName: '/worker',
    phase: 'analysis',
  });
  for (const value of [
    null,
    [],
    { agent: [] },
    { agent: { agent_name: '' } },
    { agent: { agent_name: 42 } },
  ])
    expect(getHostedAgentMetadata(value)).toBeUndefined();
  expect(
    getHostedAgentMetadata({ agent: { agent_name: 'worker' }, phase: [] }),
  ).toEqual({ agentName: 'worker' });
  expect(
    getHostedAgentMetadata({
      agent: { agent_name: 'x'.repeat(1024 * 1024 + 1) },
    }),
  ).toBeUndefined();
});
it('binds equal wire IDs to distinct admitted objects without transferring native routing fields', () => {
  const first = Object.freeze({
    callId: 'reused',
    role: null,
    model: 'selected',
  });
  const second = Object.freeze({ ...first });
  bindHostedAgentMetadata(first, {
    agent_name: 'first',
    phase: 'analysis',
    role: 'ignored',
  });
  bindHostedAgentMetadata(second, { agent_name: 'second' });
  expect(getHostedAgentMetadata({ call: first })).toEqual({
    agentName: 'first',
    phase: 'analysis',
  });
  expect(getHostedAgentMetadata({ call: second })).toEqual({
    agentName: 'second',
  });
  expect(getHostedAgentMetadata({ ...first })).toBeUndefined();
  expect(first).toEqual({ callId: 'reused', role: null, model: 'selected' });
});
it('keeps the native attribution record private in default observation summaries', () => {
  const record = projectResponseFactRecord({
    id: 'fact',
    thread_id: 'thread',
    turn_id: 'turn',
    request_id: 'native-request',
    response_id: 'response',
    fact: {
      kind: 'hosted_agent_attribution',
      item_fingerprint: 'a'.repeat(64),
      agent_name: 'worker',
      phase: 'analysis',
    },
  })!;
  expect(record.fact).toMatchObject({
    kind: 'hosted_agent_attribution',
    agentName: 'worker',
  });
  expect(summarizeResponseFactRecord(record).fact).toEqual({
    kind: 'hosted_agent_attribution',
  });
});
