import { describe, expect, it } from 'vitest';
import { Agent, handoff } from '../src';

describe('handoff description overrides', () => {
  it('preserves an explicit empty tool description', () => {
    const target = new Agent({
      name: 'Specialist',
      instructions: 'Handle specialist requests.',
    });

    const configured = handoff(target, {
      toolDescriptionOverride: '',
    });

    expect(configured.toolDescription).toBe('');
    expect(configured.getHandoffAsFunctionTool().description).toBe('');
  });

  it('keeps the generated description when the override is omitted', () => {
    const target = new Agent({
      name: 'Specialist',
      instructions: 'Handle specialist requests.',
    });

    const configured = handoff(target);

    expect(configured.toolDescription).toContain('Specialist');
    expect(configured.getHandoffAsFunctionTool().description).toBe(
      configured.toolDescription,
    );
  });
});
