import { describe, it, expect, vi } from 'vitest';
import { Agent } from '../src/agent';
import { handoff, getHandoff, Handoff } from '../src/handoff';
import { ModelBehaviorError, UserError } from '../src/errors';
import { z } from 'zod';
import logger from '../src/logger';
import { RunContext } from '../src/runContext';

const agent = new Agent({ name: 'A' });

describe('handoff()', () => {
  it('throws UserError when inputType is provided without onHandoff', () => {
    expect(() => handoff(agent, { inputType: z.object({}) })).toThrow(
      UserError,
    );
  });

  it('allows onHandoff without inputType', async () => {
    const onHandoff = vi.fn();
    const h = handoff(agent, { onHandoff });

    await h.onInvokeHandoff({} as any, '');

    expect(onHandoff).toHaveBeenCalledWith({});
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

describe('Handoff#clone', () => {
  it('returns a distinct Handoff instance and leaves the original unchanged', async () => {
    const targetAgent = new Agent({ name: 'Target Agent' });
    const filter = vi.fn((data) => data);
    const h = handoff(targetAgent, {
      inputFilter: filter,
      isEnabled: false,
      toolNameOverride: 'stable_transfer',
      toolDescriptionOverride: 'Stable transfer',
    });

    const clone = h.clone();
    clone.toolName = 'mutated_clone_transfer';

    expect(clone).toBeInstanceOf(Handoff);
    expect(clone).not.toBe(h);
    expect(h.toolName).toBe('stable_transfer');
    expect(h.toolDescription).toBe('Stable transfer');
    expect(h.inputFilter).toBe(filter);
    await expect(
      h.isEnabled({ runContext: new RunContext(), agent: targetAgent }),
    ).resolves.toBe(false);
  });

  it('preserves metadata and callback behavior without overrides', async () => {
    const targetAgent = new Agent({ name: 'Target Agent' });
    const onHandoff = vi.fn();
    const filter = vi.fn((data) => data);
    const h = handoff(targetAgent, {
      onHandoff,
      inputType: z.object({ reason: z.string() }),
      inputFilter: filter,
      isEnabled: true,
      toolNameOverride: 'stable_transfer',
      toolDescriptionOverride: 'Stable transfer',
    });
    const runContext = new RunContext();

    const clone = h.clone();
    const result = await clone.onInvokeHandoff(
      runContext,
      '{"reason":"refund"}',
    );

    expect(result).toBe(targetAgent);
    expect(onHandoff).toHaveBeenCalledWith(runContext, { reason: 'refund' });
    expect(clone.agent).toBe(h.agent);
    expect(clone.agentName).toBe(h.agentName);
    expect(clone.toolName).toBe(h.toolName);
    expect(clone.toolDescription).toBe(h.toolDescription);
    expect(clone.inputJsonSchema).toEqual(h.inputJsonSchema);
    expect(clone.strictJsonSchema).toBe(h.strictJsonSchema);
    expect(clone.inputFilter).toBe(filter);
    expect(clone.isEnabled).toBe(h.isEnabled);
    expect(clone.getHandoffAsFunctionTool()).toEqual(
      h.getHandoffAsFunctionTool(),
    );
  });

  it('supports target agent and callback overrides', async () => {
    const originalAgent = new Agent({ name: 'Original Agent' });
    const convertedAgent = new Agent({ name: 'Converted Agent' });
    const originalCallback = vi.fn();
    const overrideCallback = vi.fn(async () => convertedAgent);
    const h = handoff(originalAgent, {
      onHandoff: originalCallback,
      toolNameOverride: 'stable_transfer',
      toolDescriptionOverride: 'Stable transfer',
    });

    const clone = h.clone({
      agent: convertedAgent,
      onInvokeHandoff: overrideCallback,
    });
    const result = await clone.onInvokeHandoff(new RunContext(), '{}');

    expect(result).toBe(convertedAgent);
    expect(overrideCallback).toHaveBeenCalledOnce();
    expect(originalCallback).not.toHaveBeenCalled();
    expect(clone.agent).toBe(convertedAgent);
    expect(clone.agentName).toBe('Converted Agent');
    expect(clone.toolName).toBe('stable_transfer');
    expect(clone.toolDescription).toBe('Stable transfer');
    expect(h.agent).toBe(originalAgent);
    expect(h.agentName).toBe('Original Agent');
  });

  it('returns the replacement agent by default while preserving handoff side effects', async () => {
    const originalAgent = new Agent({ name: 'Original Agent' });
    const convertedAgent = new Agent({ name: 'Converted Agent' });
    const onHandoff = vi.fn();
    const h = handoff(originalAgent, {
      onHandoff,
      inputType: z.object({ reason: z.string() }),
      toolNameOverride: 'stable_transfer',
      toolDescriptionOverride: 'Stable transfer',
    });
    const runContext = new RunContext();

    const clone = h.clone({ agent: convertedAgent });
    const result = await clone.onInvokeHandoff(
      runContext,
      '{"reason":"reroute"}',
    );

    expect(result).toBe(convertedAgent);
    expect(onHandoff).toHaveBeenCalledWith(runContext, { reason: 'reroute' });
    expect(clone.agent).toBe(convertedAgent);
    expect(clone.agentName).toBe('Converted Agent');
    expect(clone.toolName).toBe('stable_transfer');
    expect(clone.toolDescription).toBe('Stable transfer');
  });

  it('uses explicit clone metadata overrides', async () => {
    const originalAgent = new Agent({ name: 'Original Agent' });
    const convertedAgent = new Agent({ name: 'Converted Agent' });
    const filter = vi.fn((data) => data);
    const isEnabled = vi.fn(async () => false);
    const inputJsonSchema = {
      type: 'object' as const,
      properties: { reason: { type: 'string' } },
      required: ['reason'],
      additionalProperties: false,
    };
    const h = handoff(originalAgent);

    const clone = h.clone({
      agent: convertedAgent,
      agentName: 'Runtime Target',
      toolName: 'transfer_to_runtime_target',
      toolDescription: 'Runtime target handoff',
      inputJsonSchema,
      strictJsonSchema: false,
      inputFilter: filter,
      isEnabled,
    });

    expect(clone.agent).toBe(convertedAgent);
    expect(clone.agentName).toBe('Runtime Target');
    expect(clone.toolName).toBe('transfer_to_runtime_target');
    expect(clone.toolDescription).toBe('Runtime target handoff');
    expect(clone.inputJsonSchema).toBe(inputJsonSchema);
    expect(clone.strictJsonSchema).toBe(false);
    expect(clone.inputFilter).toBe(filter);
    expect(clone.isEnabled).toBe(isEnabled);
    expect(clone.getHandoffAsFunctionTool()).toEqual({
      type: 'function',
      name: 'transfer_to_runtime_target',
      description: 'Runtime target handoff',
      parameters: inputJsonSchema,
      strict: false,
    });
    await expect(
      clone.isEnabled({ runContext: new RunContext(), agent: originalAgent }),
    ).resolves.toBe(false);
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
