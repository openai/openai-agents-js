import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../src/agent';
import { handoff, getHandoff, Handoff } from '../src/handoff';
import { ModelBehaviorError, UserError } from '../src/errors';
import { z } from 'zod';
import logger from '../src/logger';

const agent = new Agent({ name: 'A' });

describe('handoff()', () => {
  it('throws UserError when only onHandoff or inputType provided', () => {
    expect(() => handoff(agent, { onHandoff: () => {} })).toThrow(UserError);
    expect(() => handoff(agent, { inputType: z.object({}) })).toThrow(
      UserError,
    );
  });

  it('parses JSON and reports errors', async () => {
    const onHandoff = vi.fn();
    const h = handoff(agent, {
      onHandoff,
      inputType: z.object({ foo: z.string() }),
    });
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    await h.onInvokeHandoff({} as any, '{"foo":"bar"}');
    expect(onHandoff).toHaveBeenCalledWith({}, { foo: 'bar' });
    await expect(h.onInvokeHandoff({} as any, '')).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
    await expect(h.onInvokeHandoff({} as any, 'bad')).rejects.toBeInstanceOf(
      ModelBehaviorError,
    );
    if (logger.dontLogToolData) {
      expect(errorSpy).not.toHaveBeenCalled();
    } else {
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid JSON when parsing: bad. Error:'),
      );
    }
    errorSpy.mockRestore();
  });

  it('applies overrides and inputFilter', () => {
    const filter = vi.fn((d) => d);
    const h = handoff(agent, {
      onHandoff: () => {},
      inputType: z.object({}),
      toolNameOverride: 't',
      toolDescriptionOverride: 'd',
      inputFilter: filter,
    });
    expect(h.toolName).toBe('t');
    expect(h.toolDescription).toBe('d');
    expect(h.inputFilter).toBe(filter);
  });
});

describe('getHandoff', () => {
  it('returns same instance when given a Handoff', () => {
    const h = handoff(agent);
    expect(getHandoff(h)).toBe(h);
  });

  it('wraps an agent when not already a Handoff', () => {
    const result = getHandoff(agent);
    expect(result).toBeInstanceOf(Handoff);
    expect((result as Handoff<any, any>).agent).toBe(agent);
  });
});
