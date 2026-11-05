import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { register } from 'tsx/esm/api';

register();
const { openFileSession, runMigrationSessionPhase } =
  await import('../../../examples/migration-session.ts');
const [phase, path, effectsPath] = process.argv.slice(2);
const session = await openFileSession(path, path);
const retained = await session.getItems();
const expectedCount =
  phase === 'classic' || phase === 'isolated' ? 0 : phase === 'native' ? 4 : 8;
assert.equal(retained.length, expectedCount);
const result = await runMigrationSessionPhase(
  phase === 'isolated' ? 'restarted' : phase,
  session,
  effectsPath,
);
const stored = await session.getItems();
assert.deepEqual(stored.slice(0, retained.length), retained);
if (phase === 'classic') {
  // Classic persistence strips SDK placeholder IDs; retain its canonical items.
  assert.deepEqual(
    stored.map((item) => item.type),
    ['message', 'function_call', 'function_call_result', 'message'],
  );
  assert.equal(stored[1].callId, result.newItems[0].rawItem.callId);
  assert.equal(stored[2].callId, stored[1].callId);
  assert.deepEqual(stored[2].output, result.newItems[1].rawItem.output);
} else {
  assert.deepEqual(
    stored.slice(retained.length + 1),
    result.newItems.map((item) => item.rawItem),
  );
  assert.deepEqual(result.history, stored);
}
console.log(
  JSON.stringify({
    pid: process.pid,
    stored: stored.length,
    newItems: result.newItems.length,
    history: result.history.length,
  }),
);
