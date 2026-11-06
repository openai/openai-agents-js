import assert from 'node:assert/strict';
import type { _NativeSessionEventBatch } from '../../native/index.js';

export type NativeEventBatch = _NativeSessionEventBatch;

export function nativeEventBatch(events: string[]): _NativeSessionEventBatch {
  return { events, rootTextOnly: false };
}

const passiveKinds = new Set([
  'agent_message',
  'user_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
  'agent_reasoning_section_break',
  'warning',
  'mcp_startup_complete',
  'thread_settings_applied',
  'token_count',
]);

function assertRootText(event: ReturnType<typeof JSON.parse>) {
  assert.deepEqual(Object.keys(event).sort(), ['id', 'msg']);
  assert.deepEqual(Object.keys(event.msg).sort(), [
    'delta',
    'item_id',
    'thread_id',
    'turn_id',
    'type',
  ]);
  assert.equal(typeof event.id, 'string');
  assert.equal(event.msg.type, 'agent_message_content_delta');
  assert.equal(event.msg.turn_id, event.id);
  for (const field of ['thread_id', 'turn_id', 'item_id', 'delta'])
    assert.equal(typeof event.msg[field], 'string');
}

/** Validate the whole batch; control gates remain singleton at index zero. */
export function firstNativeBatchWire(value: _NativeSessionEventBatch): string {
  const batch = value.events;
  assert(batch.length > 0 && batch.length <= 8, 'Native batch count bound');
  assert.equal(typeof value.rootTextOnly, 'boolean');
  const events = batch.map((wire) => JSON.parse(wire));
  const first = events[0];
  if (batch.length > 1) {
    assert(
      batch.reduce((bytes, wire) => bytes + Buffer.byteLength(wire), 0) <=
        16 * 1024,
      'Native batch byte bound',
    );
    const thread = events.find((event) => event.msg.thread_id !== undefined)
      ?.msg.thread_id;
    for (const event of events) {
      assert.equal(typeof event.id, 'string');
      assert.equal(event.id, first.id);
      for (const key of [
        'subagent_id',
        'subagent_incarnation',
        'subagent_instance_id',
      ])
        assert.equal(Object.hasOwn(event, key), false);
      if (event.msg.thread_id !== undefined)
        assert.equal(event.msg.thread_id, thread);
      if (event.msg.turn_id !== undefined)
        assert.equal(event.msg.turn_id, event.id);
      if (event.msg.type === 'agent_message_content_delta') {
        assertRootText(event);
      } else if (event.msg.type === 'raw_response_item') {
        const item = event.msg.item;
        assert(
          item?.type === 'reasoning' ||
            (item?.type === 'message' && item.role === 'assistant'),
          'Only passive raw items may share a batch',
        );
      } else if (event.msg.type === 'item_started') {
        assert.equal(typeof event.msg.thread_id, 'string');
        assert.equal(event.msg.turn_id, event.id);
        assert(['AgentMessage', 'Reasoning'].includes(event.msg.item?.type));
      } else {
        assert(
          passiveKinds.has(event.msg.type),
          'Control must remain singleton',
        );
      }
    }
  }
  if (value.rootTextOnly) {
    for (const [index, event] of events.entries()) {
      assertRootText(event);
      assert(Buffer.byteLength(batch[index]!) < 16 * 1024);
    }
  }
  return batch[0]!;
}

/** Existing terminal-hint projections must change only a singleton control. */
export function replaceSingletonNativeBatchEvent(
  batch: _NativeSessionEventBatch,
  event: unknown,
): _NativeSessionEventBatch {
  firstNativeBatchWire(batch);
  assert.equal(
    batch.events.length,
    1,
    'Projected control must remain a singleton',
  );
  return nativeEventBatch([JSON.stringify(event)]);
}
