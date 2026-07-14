import { describe, expect, it } from 'vitest';

import {
  buildAbortReconciliationInput,
  createStreamAbortReconciliationState,
  recordStreamEventForAbortReconciliation,
} from '../../src/runner/streamReconciliation';

describe('stream abort reconciliation', () => {
  it('preserves Programmatic Tool Calling caller linkage', () => {
    const state = createStreamAbortReconciliationState();

    recordStreamEventForAbortReconciliation(state, {
      type: 'model',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{}',
          caller: { type: 'program', caller_id: 'call_prog_1' },
        },
      },
    });

    expect(buildAbortReconciliationInput(state)).toEqual([
      {
        type: 'function_call_result',
        name: 'lookup',
        callId: 'call_1',
        status: 'incomplete',
        output: { type: 'text', text: 'aborted' },
        caller: { type: 'program', callerId: 'call_prog_1' },
      },
    ]);
  });
});
