import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { RunContext } from '../src/runContext';

describe('handoff callback errors', () => {
  it('preserves an onHandoff error after valid input is parsed', async () => {
    const target = new Agent({ name: 'Target' });
    const callbackError = new Error('database unavailable');
    const h = handoff(target, {
      inputType: z.object({ reason: z.string() }),
      onHandoff: async () => {
        throw callbackError;
      },
    });

    await expect(
      h.onInvokeHandoff(new RunContext(), '{"reason":"billing"}'),
    ).rejects.toBe(callbackError);
  });
});
