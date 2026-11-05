import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, tool, type ModelSettings } from '@openai/agents-core';
import { ScriptedModel } from '@openai/agents-core/testing';
import { capture } from '../../src/migration/run';

type Declaration = { name: string; enabled?: boolean };

function fixture(
  choice: ModelSettings['toolChoice'],
  declarations: readonly Declaration[],
) {
  const model = new ScriptedModel([]);
  const getModel = vi.fn(async () => model);
  const instructions = vi.fn(() => 'Trusted instructions');
  const execute = vi.fn(() => 'Application effect');
  const tools = declarations.map(({ name, enabled = true }) =>
    tool({
      name,
      description: 'An ordinary factory function.',
      parameters: z.object({}),
      isEnabled: enabled,
      execute,
    }),
  );
  const context = { account: 'original' };
  const agent = new Agent<typeof context>({
    name: 'Control admission',
    instructions,
    model,
    modelSettings: { toolChoice: choice },
    tools,
  });
  const options = { context, modelProvider: { getModel } };
  return { agent, model, tools, options, getModel, instructions, execute };
}

function expectNoWork(current: ReturnType<typeof fixture>) {
  expect(current.getModel).not.toHaveBeenCalled();
  expect(current.instructions).not.toHaveBeenCalled();
  expect(current.execute).not.toHaveBeenCalled();
  expect(current.model.calls).toHaveLength(0);
}

// Capture only: no binding, native Session, provider resolution or callback work.
describe('migration control declaration admission', () => {
  it('refuses the Classic-only modelOverride before callback or provider work', () => {
    const current = fixture('auto', [{ name: 'lookup' }]);
    const override = new ScriptedModel([]);
    const options = { ...current.options, modelOverride: override };

    expect(() => capture(current.agent, 'Hello', options)).toThrow(
      'does not support run option modelOverride',
    );
    expectNoWork(current);
    expect(override.calls).toHaveLength(0);
  });

  it.each(['lookup', 'computer'])(
    'admits enabled ordinary function choice %s and preserves its original tool',
    (name) => {
      const current = fixture(name, [{ name }]);
      const admitted = capture(current.agent, 'Hello', current.options);

      expect(admitted.settings.toolChoice).toBe(name);
      expect(admitted.selected).toBe(current.model);
      expect(admitted.context).toBe(current.options.context);
      expect(admitted.tools).toHaveLength(1);
      expect(admitted.tools[0].source).toBe(current.tools[0]);
      expect(admitted.tools[0].invoke).toBe(current.tools[0].invoke);

      current.agent.modelSettings = { toolChoice: 'auto' };
      const overridden = capture(current.agent, 'Hello', {
        ...current.options,
        modelSettings: { toolChoice: name },
      });
      expect(overridden.settings.toolChoice).toBe('auto');
      expect(overridden.tools[0].source).toBe(current.tools[0]);
      expectNoWork(current);
    },
  );

  it.each([
    {
      boundary: 'disabled function',
      choice: 'lookup',
      declarations: [{ name: 'lookup', enabled: false }],
    },
    {
      boundary: 'missing function',
      choice: 'missing',
      declarations: [{ name: 'lookup' }],
    },
    {
      boundary: 'Responses hosted-selector collision',
      choice: 'file_search',
      declarations: [{ name: 'file_search' }],
    },
  ])('rejects a $boundary before any work', ({ choice, declarations }) => {
    const current = fixture(choice, declarations);
    expect(() => capture(current.agent, 'Hello', current.options)).toThrow(
      'enabled ordinary-function tool choice',
    );
    expectNoWork(current);
  });

  it.each([
    { roster: 'empty', declarations: [] },
    {
      roster: 'disabled-only',
      declarations: [{ name: 'lookup', enabled: false }],
    },
  ])(
    'rejects required with an $roster roster before work',
    ({ declarations }) => {
      const current = fixture('required', declarations);
      expect(() => capture(current.agent, 'Hello', current.options)).toThrow(
        'enabled ordinary-function tool choice',
      );
      expectNoWork(current);
    },
  );

  it.each(['auto', 'none'] as const)(
    'admits %s with an empty roster without doing work',
    (choice) => {
      const current = fixture(choice, []);
      const admitted = capture(current.agent, 'Hello', current.options);
      expect(admitted.settings.toolChoice).toBe(choice);
      expect(admitted.tools).toEqual([]);
      expectNoWork(current);
    },
  );

  it('rejects an unadmitted option choice even when the Agent overrides it', () => {
    const current = fixture('auto', [{ name: 'lookup' }]);
    expect(() =>
      capture(current.agent, 'Hello', {
        ...current.options,
        modelSettings: { toolChoice: 'missing' },
      }),
    ).toThrow('enabled ordinary-function tool choice');
    expectNoWork(current);
  });

  it('rejects a nonstring choice from a JavaScript caller before work', () => {
    const current = fixture('auto', [{ name: 'lookup' }]);
    Object.assign(current.agent.modelSettings, { toolChoice: 42 });
    expect(() => capture(current.agent, 'Hello', current.options)).toThrow(
      'model setting toolChoice',
    );
    expectNoWork(current);
  });

  it('rejects a nonboolean reset control from a JavaScript caller before work', () => {
    const current = fixture('auto', [{ name: 'lookup' }]);
    Object.assign(current.agent, { resetToolChoice: 'false' });
    expect(() => capture(current.agent, 'Hello', current.options)).toThrow(
      'boolean resetToolChoice',
    );
    expectNoWork(current);
  });
});
