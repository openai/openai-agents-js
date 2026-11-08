import assert from 'node:assert/strict';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import { runV0Lookup } from './app.mts';

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
  [functionCall('lookup_order', { orderId: 'ORDER-42' }, { callId: 'lookup' })],
  [assistantMessage(JSON.stringify(expected))],
]);
assert.deepEqual(await runV0Lookup(model, context), expected);
assert(JSON.stringify(model.calls[1].request.input).includes('TRACK-42'));
assert(!JSON.stringify(model.calls[1].request.input).includes('PRIVATE'));
model.assertComplete();
console.log('v0 read-only lookup passed');
