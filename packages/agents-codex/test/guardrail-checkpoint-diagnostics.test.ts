import { expect, it } from 'vitest';
import { Session } from '../src/runtime/session';

function capture(info: unknown) {
  const agent = {};
  const record = {
    kind: 'input',
    name: 'guard',
    agent,
    sessionId: 'session',
    turnId: 'turn',
    result: { tripwireTriggered: false, outputInfo: info },
  };
  const owner = {
    options: { applicationAgent: agent },
    profileRuntimes: new Map(),
    voiceProfileGraphs: new Map(),
    rootSteps: () => [{ guardrailResults: [record] }],
  };
  const snapshot = Reflect.get(Session.prototype, 'checkpointGuardrailRecords');
  return { record, snapshot: snapshot.call(owner, {}) };
}

it.each([
  new Date('2026-01-01T00:00:00Z'),
  new Error('local'),
  { nested: undefined },
])(
  'omits unsupported durable diagnostics while preserving live values (%s)',
  (info) => {
    const { record, snapshot } = capture(info);
    expect(snapshot[0].result).toEqual({ tripwireTriggered: false });
    expect(record.result.outputInfo).toBe(info);
  },
);
it('detaches JSON diagnostics and omits cycles', () => {
  const info = { details: ['original'] };
  const { snapshot } = capture(info);
  info.details.push('later');
  expect(snapshot[0].result.outputInfo).toEqual({ details: ['original'] });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const captured = capture(cyclic);
  expect(captured.snapshot[0].result).toEqual({ tripwireTriggered: false });
  expect(captured.record.result.outputInfo).toBe(cyclic);
});
