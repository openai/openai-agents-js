import { expect, it } from 'vitest';
import { captureModelSettings } from '../../src/runtime/provider';
import { ObservationBuffer } from '../../src/runtime/observation';
import { projectResponseFactRecord } from '../../src/runtime/response-facts';

function raw(kind: 'refusal' | 'text_probabilities' = 'refusal') {
  const fact =
    kind === 'refusal'
      ? {
          kind,
          item_id: 'item',
          content_index: 0,
          snapshot: true,
          text: 'SYNTHETIC_PRIVATE_REFUSAL',
          capture_complete: true,
        }
      : {
          kind,
          item_id: 'item',
          content_index: 0,
          output_index: 0,
          snapshot: false,
          delta: 'a',
          capture_complete: true,
          tokens: [
            {
              token: 'a',
              bytes: [97],
              logprob: -1,
              top_logprobs: [
                {
                  token: 'SYNTHETIC_PRIVATE_ALTERNATIVE',
                  bytes: [],
                  logprob: -2,
                },
              ],
            },
          ],
        };
  return {
    id: 'fact',
    thread_id: 'thread',
    turn_id: 'turn',
    request_id: 'native-request',
    response_id: 'response',
    fact,
  };
}
for (const value of [0, 20, null])
  it(`preserves requested topLogprobs ${value}`, () => {
    expect(captureModelSettings({ topLogprobs: value })).toEqual({
      topLogprobs: value,
    });
  });
for (const value of [-1, 256, 1.5, true, '1'])
  it(`rejects malformed topLogprobs ${String(value)}`, () => {
    expect(() =>
      captureModelSettings({ topLogprobs: value as number }),
    ).toThrow(/topLogprobs/);
  });
it('projects only typed fields and preserves empty versus missing provider bytes', () => {
  const source = raw('text_probabilities') as any;
  source.authorization = 'NEVER_FORWARD';
  source.fact.tokens[0].authorization = 'NEVER_FORWARD';
  const projected = projectResponseFactRecord(source)!;
  expect(JSON.stringify(projected)).not.toContain('NEVER_FORWARD');
  expect(projected.requestId).not.toBe(projected.responseId);
  if (projected.fact.kind !== 'text_probabilities')
    throw Error('wrong typed fact');
  expect(projected.fact.tokens[0].bytes).toEqual([97]);
  expect(projected.fact.tokens[0].topLogprobs![0].bytes).toEqual([]);
  delete source.fact.tokens[0].bytes;
  delete source.fact.tokens[0].top_logprobs;
  const missing = projectResponseFactRecord(source)!;
  if (missing.fact.kind !== 'text_probabilities')
    throw Error('wrong typed fact');
  expect(missing.fact.tokens[0]).not.toHaveProperty('bytes');
  expect(missing.fact.tokens[0]).not.toHaveProperty('topLogprobs');
});
for (const kind of ['refusal', 'text_probabilities'] as const)
  it(`keeps default ${kind} observations private and trusted readers independent`, async () => {
    const buffer = new ObservationBuffer('session');
    buffer.append({
      type: 'response_fact',
      turnId: 'turn',
      submissionId: 'submission',
      record: projectResponseFactRecord(raw(kind))!,
    });
    const ordinary = buffer.events(),
      trusted = buffer.events({ includeExecutionDetails: true });
    const a = await ordinary.next(),
      b = await trusted.next();
    expect(JSON.stringify(a.value)).not.toContain('SYNTHETIC_PRIVATE');
    expect(JSON.stringify(b.value)).toContain('SYNTHETIC_PRIVATE');
    if (b.value?.type !== 'response_fact') throw Error('missing trusted fact');
    (b.value.record as any).fact = {};
    const another = buffer.events({ includeExecutionDetails: true });
    expect(JSON.stringify((await another.next()).value)).toContain(
      'SYNTHETIC_PRIVATE',
    );
    await ordinary.return?.();
    await trusted.return?.();
    await another.return?.();
  });
it('counts received fact payloads in the existing bounded observation suffix', async () => {
  const buffer = new ObservationBuffer('session');
  const source = raw() as any;
  source.fact.text = 'p'.repeat(70_000);
  buffer.append({
    type: 'response_fact',
    turnId: 'turn',
    submissionId: 'submission',
    record: projectResponseFactRecord(source)!,
  });
  const events = buffer.events();
  expect((await events.next()).value?.type).toBe('gap');
  await events.return?.();
});
