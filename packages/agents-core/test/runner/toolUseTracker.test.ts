import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/agent';
import { AgentToolUseTracker } from '../../src/runner/toolUseTracker';

describe('AgentToolUseTracker', () => {
  const tracker = new AgentToolUseTracker();
  const agent = new Agent({ name: 'A' });

  it('skips initial empty writes unless explicitly allowed', () => {
    tracker.addToolUse(agent, []);
    expect(tracker.hasUsedTools(agent)).toBe(false);

    tracker.addToolUse(agent, [], { allowEmpty: true });
    expect(tracker.hasUsedTools(agent)).toBe(true);
    expect(tracker.toJSON()).toEqual({ A: [] });
  });

  it('does not downgrade non-empty history unless allowEmpty is set', () => {
    tracker.addToolUse(agent, ['tool1']);
    expect(tracker.toJSON()).toEqual({ A: ['tool1'] });

    tracker.addToolUse(agent, []); // should be ignored
    expect(tracker.toJSON()).toEqual({ A: ['tool1'] });

    tracker.addToolUse(agent, [], { allowEmpty: true });
    expect(tracker.toJSON()).toEqual({ A: [] });
  });
});
