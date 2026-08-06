import { describe, expect, it } from 'vitest';

import {
  buildAbortReconciliationInput,
  createStreamAbortReconciliationState,
  recordStreamEventForAbortReconciliation,
  shouldReconcileStreamAbort,
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

  it('reconciles program-owned shell and apply_patch calls', () => {
    const state = createStreamAbortReconciliationState();

    for (const item of [
      {
        type: 'shell_call',
        id: 'shell_1',
        call_id: 'call_shell_1',
        status: 'completed',
        action: { commands: ['sleep 10'] },
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
      {
        type: 'apply_patch_call',
        id: 'patch_1',
        call_id: 'call_patch_1',
        status: 'completed',
        operation: { type: 'delete_file', path: 'temporary.txt' },
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
    ]) {
      recordStreamEventForAbortReconciliation(state, {
        type: 'model',
        event: {
          type: 'response.output_item.done',
          item,
        },
      });
    }

    expect(shouldReconcileStreamAbort(state)).toBe(true);
    expect(buildAbortReconciliationInput(state)).toEqual([
      {
        type: 'shell_call_output',
        callId: 'call_shell_1',
        status: 'incomplete',
        output: [
          {
            stdout: '',
            stderr: 'aborted',
            outcome: { type: 'timeout' },
          },
        ],
        caller: { type: 'program', callerId: 'call_prog_1' },
      },
      {
        type: 'apply_patch_call_output',
        callId: 'call_patch_1',
        status: 'failed',
        output: 'aborted',
        caller: { type: 'program', callerId: 'call_prog_1' },
      },
    ]);
  });

  it('does not reconcile shell and apply_patch calls that have outputs', () => {
    const state = createStreamAbortReconciliationState();

    for (const item of [
      {
        type: 'shell_call',
        id: 'shell_1',
        call_id: 'call_shell_1',
        status: 'completed',
        action: { commands: ['echo done'] },
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
      {
        type: 'apply_patch_call',
        id: 'patch_1',
        call_id: 'call_patch_1',
        status: 'completed',
        operation: { type: 'delete_file', path: 'temporary.txt' },
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
      {
        type: 'shell_call_output',
        call_id: 'call_shell_1',
        status: 'completed',
        output: [
          {
            stdout: 'done\n',
            stderr: '',
            outcome: { type: 'exit', exit_code: 0 },
          },
        ],
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
      {
        type: 'apply_patch_call_output',
        call_id: 'call_patch_1',
        status: 'completed',
        output: 'Done!',
        caller: { type: 'program', caller_id: 'call_prog_1' },
      },
    ]) {
      recordStreamEventForAbortReconciliation(state, {
        type: 'model',
        event: {
          type: 'response.output_item.done',
          item,
        },
      });
    }

    expect(shouldReconcileStreamAbort(state)).toBe(false);
    expect(buildAbortReconciliationInput(state)).toEqual([]);
  });

  it('does not reconcile server-owned hosted shell calls', () => {
    const state = createStreamAbortReconciliationState();

    recordStreamEventForAbortReconciliation(state, {
      type: 'model',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'shell_call',
          id: 'shell_hosted',
          call_id: 'call_shell_hosted',
          status: 'in_progress',
          action: { commands: ['echo hosted'] },
          environment: {
            type: 'container_reference',
            container_id: 'container_123',
          },
          caller: { type: 'program', caller_id: 'call_prog_1' },
        },
      },
    });

    expect(shouldReconcileStreamAbort(state)).toBe(false);
    expect(buildAbortReconciliationInput(state)).toEqual([]);
  });

  it('reconciles programs that have no program output', () => {
    const state = createStreamAbortReconciliationState();

    recordStreamEventForAbortReconciliation(state, {
      type: 'model',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'program',
          id: 'prog_1',
          call_id: 'call_prog_1',
          code: 'text("done");',
          fingerprint: 'fingerprint:program-1',
        },
      },
    });

    expect(shouldReconcileStreamAbort(state)).toBe(true);
    const firstInput = buildAbortReconciliationInput(state);
    expect(firstInput).toEqual([
      expect.objectContaining({
        type: 'program_output',
        id: expect.stringMatching(/^prog_out_[0-9a-f]{32}$/),
        callId: 'call_prog_1',
        status: 'incomplete',
        output: 'aborted',
      }),
    ]);
    expect(buildAbortReconciliationInput(state)).toEqual(firstInput);
  });

  it('preserves a streamed program output id during reconciliation', () => {
    const state = createStreamAbortReconciliationState();

    recordStreamEventForAbortReconciliation(state, {
      type: 'model',
      event: {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'program_output',
          id: 'prog_out_streamed',
          call_id: 'call_prog_1',
          result: '',
          status: 'in_progress',
        },
        sequence_number: 1,
      },
    });

    expect(buildAbortReconciliationInput(state)).toEqual([
      {
        type: 'program_output',
        id: 'prog_out_streamed',
        callId: 'call_prog_1',
        status: 'incomplete',
        output: 'aborted',
      },
    ]);
  });

  it('does not reconcile programs that already have an output', () => {
    const state = createStreamAbortReconciliationState();

    for (const item of [
      {
        type: 'program',
        id: 'prog_1',
        call_id: 'call_prog_1',
        code: 'text("done");',
        fingerprint: 'fingerprint:program-1',
      },
      {
        type: 'program_output',
        id: 'prog_out_1',
        call_id: 'call_prog_1',
        result: 'done',
        status: 'completed',
      },
    ]) {
      recordStreamEventForAbortReconciliation(state, {
        type: 'model',
        event: {
          type: 'response.output_item.done',
          item,
        },
      });
    }

    expect(shouldReconcileStreamAbort(state)).toBe(false);
    expect(buildAbortReconciliationInput(state)).toEqual([]);
  });
});
