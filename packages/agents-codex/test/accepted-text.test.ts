import { expect, it } from 'vitest';
import { acceptedText } from '../src/runtime/accepted-text';
import type { Observation } from '../src/runtime/observation';

function delta(text: string, itemId = 'answer'): Observation {
  return {
    type: 'output_text_delta',
    sessionId: 'session',
    submissionId: 'root',
    turnId: 'turn',
    itemId,
    delta: text,
    sequence: 1,
  };
}
async function* events(...values: Observation[]) {
  yield* values;
}

it('publishes only approved contiguous prefixes and waits for more text', async () => {
  const pending: string[] = [];
  const published = [];
  for await (const chunk of acceptedText(
    events(delta('first'), delta('. second'), delta('. unsafe')),
    (text) => {
      pending.push(text);
      const end = text.indexOf('.');
      return end < 0 ? undefined : text.slice(0, end + 1);
    },
    () => true,
  ))
    published.push(chunk.text);
  expect(pending).toEqual(['first', 'first. second', ' second. unsafe']);
  expect(published).toEqual(['first.', ' second.']);
});

it('discards an unapproved tail on an item transition', async () => {
  const pending: string[] = [];
  for await (const _chunk of acceptedText(
    events(delta('private'), delta('public', 'next')),
    (text) => {
      pending.push(text);
      return undefined;
    },
    () => true,
  )) {
    /* No publication. */
  }
  expect(pending).toEqual(['private', 'public']);
});

it('rejects invalid approval and observation loss without candidate content in errors', async () => {
  const invalid = acceptedText(
    events(delta('secret')),
    () => 'other',
    () => true,
  );
  await expect(invalid.next()).rejects.toThrow('exact pending prefix');
  const lost = acceptedText(
    events({
      type: 'gap',
      sessionId: 'session',
      sequence: 1,
      firstSequence: 1,
    }),
    () => 'x',
    () => true,
  );
  await expect(lost.next()).rejects.toThrow('gap');
});

it('withholds approval when cancellation or source retirement happens during an await', async () => {
  let active = true;
  const reader = acceptedText(
    events(delta('candidate')),
    async (text) => {
      await Promise.resolve();
      active = false;
      return text;
    },
    () => active,
  );
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});

it('bounds retained UTF-8 pending content and propagates callback errors', async () => {
  const oversized = acceptedText(
    events(delta('é'.repeat(32769))),
    () => undefined,
    () => true,
  );
  await expect(oversized.next()).rejects.toThrow('65536 bytes');
  const failure = new Error('application failure');
  const reader = acceptedText(
    events(delta('candidate')),
    () => {
      throw failure;
    },
    () => true,
  );
  await expect(reader.next()).rejects.toBe(failure);
});

it('rejects an approval boundary inside a Unicode code point', async () => {
  const reader = acceptedText(
    events(delta('😀 pending')),
    (text) => text.slice(0, 1),
    () => true,
  );
  await expect(reader.next()).rejects.toThrow('Unicode code point');
});
