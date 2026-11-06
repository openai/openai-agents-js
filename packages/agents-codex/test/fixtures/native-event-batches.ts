import assert from 'node:assert/strict';

export type NativeEventBatch = string[];

export function nativeEventBatch(events: string[]): NativeEventBatch {
  return events;
}

/** Text batches share one owner; control events remain singletons. */
export function firstNativeBatchWire(batch: NativeEventBatch): string {
  assert(batch.length > 0 && batch.length <= 8, 'Native batch count bound');
  if (batch.length > 1) {
    assert(
      batch.reduce((bytes, wire) => bytes + Buffer.byteLength(wire), 0) <=
        16 * 1024,
      'Native batch byte bound',
    );
    const events = batch.map((wire) => JSON.parse(wire));
    const first = events[0];
    for (const event of events) {
      assert.equal(typeof event.id, 'string');
      assert.equal(event.id, first.id);
      assert.equal(event.msg.type, 'agent_message_content_delta');
      assert.equal(event.msg.thread_id, first.msg.thread_id);
      assert.equal(event.msg.turn_id, event.id);
      for (const field of ['thread_id', 'turn_id', 'item_id', 'delta'])
        assert.equal(typeof event.msg[field], 'string');
      for (const field of [
        'subagent_id',
        'subagent_incarnation',
        'subagent_instance_id',
      ])
        assert.equal(Object.hasOwn(event, field), false);
    }
  }
  return batch[0]!;
}

/** Existing terminal-hint projections must change only a singleton control. */
export function replaceSingletonNativeBatchEvent(
  batch: NativeEventBatch,
  event: unknown,
): NativeEventBatch {
  firstNativeBatchWire(batch);
  assert.equal(batch.length, 1, 'Projected control must remain a singleton');
  return nativeEventBatch([JSON.stringify(event)]);
}
