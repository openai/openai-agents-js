import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInvoiceTotal } from '../src/invoice.mjs';

test('formatInvoiceTotal applies tax as a percentage of the subtotal', () => {
  assert.equal(formatInvoiceTotal(100, 0.075), '$107.50');
});
