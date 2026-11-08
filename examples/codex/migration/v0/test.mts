import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { MemorySession, Runner } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import { v0Lookup } from './app.mts';

const installed = JSON.parse(
  await readFile(
    new URL('../package.json', import.meta.resolve('@openai/agents')),
    'utf8',
  ),
);
assert.equal(installed.version, '0.21.0');

const expected = {
  orderId: 'ORDER-42',
  status: 'shipped',
  tracking: 'TRACK-42',
};
const context = {
  customerId: 'CUSTOMER-7',
  orders: [
    {
      customerId: 'CUSTOMER-8',
      orderId: 'ORDER-42',
      status: 'private',
      tracking: 'PRIVATE',
    },
    { customerId: 'CUSTOMER-7', ...expected },
  ],
};
const model = new ScriptedModel([
  [
    functionCall(
      'lookup_order',
      { orderId: 'ORDER-42' },
      { callId: 'old-v0-lookup' },
    ),
  ],
  [assistantMessage(JSON.stringify(expected))],
]);
const session = new MemorySession();
const result = await new Runner({ tracingDisabled: true }).run(
  v0Lookup(model),
  'Where is ORDER-42?',
  { context, session },
);
assert.deepEqual(result.finalOutput, expected);
assert.deepEqual(
  result.newItems.find((item) => item.type === 'tool_call_output_item')?.output,
  expected,
);
assert(JSON.stringify(model.calls[1].request.input).includes('TRACK-42'));
assert(!JSON.stringify(model.calls[1].request.input).includes('PRIVATE'));
model.assertComplete();
console.log('v0 read-only lookup passed');

if (process.env.MIGRATION_V0_RECORD) {
  await writeFile(
    process.env.MIGRATION_V0_RECORD,
    JSON.stringify({
      sdkVersion: installed.version,
      facts: result.finalOutput,
      state: result.state.toString(),
      history: await session.getItems(),
    }),
  );
}
