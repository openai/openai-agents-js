import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Agent, captureAgentProfiles } from '../src/runtime/public-agent';
import { captureProfileRuntimes } from '../src/runtime/agent-profiles';
import { captureTools } from '../src/runtime/tools';
import {
  captureHostedPromptReference,
  captureHostedPromptSource,
  hostedPromptControls,
} from '../src/runtime/hosted-prompts';

describe('hosted prompt reference capture', () => {
  it('detaches nested file variables while preserving reference data', () => {
    const source = {
      id: 'pmpt_captured',
      version: '3',
      variables: {
        name: 'Ada',
        file: { type: 'input_file', file_id: 'file_1' },
      },
    };
    const captured = captureHostedPromptReference(source);
    source.variables.file.file_id = 'file_changed';
    source.variables.name = 'changed';
    expect(captured).toEqual({
      id: 'pmpt_captured',
      version: '3',
      variables: {
        name: 'Ada',
        file: { type: 'input_file', file_id: 'file_1' },
      },
    });
  });

  it('captures static values and retains an authorized factory without invoking it', () => {
    let calls = 0;
    const factory = () => {
      calls++;
      return { id: 'pmpt_dynamic' };
    };
    expect(captureHostedPromptSource(factory)).toBe(factory);
    expect(calls).toBe(0);
    expect(captureHostedPromptSource(undefined)).toBeUndefined();
    expect(captureHostedPromptSource({ id: 'pmpt_static' })).toEqual({
      id: 'pmpt_static',
    });
    expect(
      captureHostedPromptSource({
        id: 'pmpt_static',
        version: undefined,
        variables: undefined,
      }),
    ).toEqual({ id: 'pmpt_static' });
  });

  it.each([
    null,
    [],
    {},
    { id: '' },
    { id: '   ' },
    { id: 3 },
    { id: 'pmpt_1', version: null },
    { id: 'pmpt_1', variables: [] },
    { id: 'pmpt_1', variables: { value: Number.NaN } },
    { id: 'pmpt_1', instructions: 'unrecognized' },
  ])(
    'rejects malformed references before client or native dispatch: %j',
    (value) => {
      expect(() => captureHostedPromptReference(value)).toThrow(TypeError);
    },
  );

  it('preserves omitted versus explicitly empty instructions and tool selections', () => {
    const source = { id: 'pmpt_defaults' };
    expect(hostedPromptControls(source, { toolsProvided: false })).toEqual({
      reference: source,
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    });
    expect(
      hostedPromptControls(source, {
        model: 'explicit-model',
        instructions: '',
        toolsProvided: true,
      }),
    ).toEqual({
      reference: source,
      omit_model: false,
      omit_instructions: false,
      omit_tools: false,
    });
  });

  it('keeps a dynamic source unresolved until its admitted callback', () => {
    const source = () => {
      throw new Error('not admitted');
    };
    expect(hostedPromptControls(source, { toolsProvided: false })).toEqual({
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    });
    expect(
      hostedPromptControls(undefined, { toolsProvided: false }),
    ).toBeUndefined();
  });

  it('rejects conflicting raw references without discarding explicit caller data', () => {
    expect(() =>
      hostedPromptControls(
        { id: 'pmpt_1' },
        {
          toolsProvided: false,
          extraBody: { prompt: null },
        },
      ),
    ).toThrow(/conflicts/);
  });

  it('requires instructions for ordinary Agents and permits provider-owned prompt instructions', () => {
    // @ts-expect-error An ordinary declaration still requires instructions.
    expect(() => new Agent({})).toThrow(/instructions are required/);
    const agent = new Agent({ hostedPrompt: { id: 'pmpt_defaults' } });
    expect(agent.instructions).toBe('');
    expectTypeOf(agent.instructions).toEqualTypeOf<string>();
    expect(agent.hostedPrompt).toEqual({ id: 'pmpt_defaults' });
    expect(
      new Agent({ instructions: '', hostedPrompt: { id: 'pmpt_clear' } })
        .instructions,
    ).toBe('');
  });

  it('preserves string reads, own enumeration and explicit spread values', () => {
    const ordinary = new Agent({ instructions: 'ordinary' });
    expectTypeOf(ordinary.instructions).toEqualTypeOf<string>();
    expect(Object.keys(ordinary)).toContain('instructions');
    expect({ ...ordinary }.instructions).toBe('ordinary');
    const omitted = new Agent({ hostedPrompt: { id: 'pmpt_defaults' } });
    expect(Object.keys(omitted)).toContain('instructions');
    expect({ ...omitted }.instructions).toBe('');
    // Spreading the public string into new options supplies an explicit value.
    expect(
      captureAgentProfiles(new Agent({ ...omitted }))[0]!.hostedPromptControls
        ?.omit_instructions,
    ).toBe(false);
  });

  it('keeps omission through capture and honors later explicit empty assignment', () => {
    const agent = new Agent({ hostedPrompt: { id: 'pmpt_defaults' } });
    const captured = captureAgentProfiles(agent)[0]!.declaration;
    expect(
      captureAgentProfiles(captured)[0]!.hostedPromptControls
        ?.omit_instructions,
    ).toBe(true);
    expect(() => {
      captured.instructions = 'changed';
    }).toThrow(TypeError);
    expect(captured.instructions).toBe('');
    agent.instructions = '';
    expect(
      captureAgentProfiles(agent)[0]!.hostedPromptControls?.omit_instructions,
    ).toBe(false);
    agent.hostedPrompt = undefined;
    expect(() => captureAgentProfiles(agent)).not.toThrow();
  });

  it('treats a replaced own instructions property as explicit', () => {
    const agent = new Agent({ hostedPrompt: { id: 'pmpt_defaults' } });
    Object.defineProperty(agent, 'instructions', {
      value: '',
      enumerable: true,
    });
    expect(
      captureAgentProfiles(agent)[0]!.hostedPromptControls?.omit_instructions,
    ).toBe(false);
  });

  it('captures prompt source and omission across native profile declarations', () => {
    const reference = { id: 'pmpt_profile', variables: { name: 'captured' } };
    const agent = new Agent({ hostedPrompt: reference });
    const [profile] = captureAgentProfiles(agent);
    reference.variables.name = 'mutated';
    agent.hostedPrompt = { id: 'pmpt_replaced' };
    expect(profile!.declaration.hostedPrompt).toEqual({
      id: 'pmpt_profile',
      variables: { name: 'captured' },
    });
    expect(profile!.hostedPromptControls).toEqual({
      reference: { id: 'pmpt_profile', variables: { name: 'captured' } },
      omit_model: true,
      omit_instructions: true,
      omit_tools: true,
    });
    expect(
      captureAgentProfiles(
        new Agent({
          instructions: '',
          tools: [],
          hostedPrompt: { id: 'pmpt_explicit' },
        }),
      )[0]!.hostedPromptControls,
    ).toEqual({
      reference: { id: 'pmpt_explicit' },
      omit_model: true,
      omit_instructions: false,
      omit_tools: false,
    });
  });
  it('keeps ordinary native graph controls free of prompt metadata', () => {
    const child = new Agent({
      name: 'child',
      instructions: 'child instructions',
    });
    const root = new Agent({
      instructions: 'root instructions',
      handoffs: [child],
    });
    const graph = captureProfileRuntimes(
      captureAgentProfiles(root),
      captureTools([]),
      root.instructions!,
    );
    expect(graph.roster).toHaveLength(2);
    for (const row of graph.roster)
      expect(
        (row.model as { request_controls: object }).request_controls,
      ).not.toHaveProperty('hosted_prompt');
  });

  it('clears hosted ownership on a separately captured ordinary profile', () => {
    const child = new Agent({
      name: 'ordinary',
      instructions: 'explicit child',
    });
    const root = new Agent({
      hostedPrompt: { id: 'pmpt_root' },
      handoffs: [child],
    });
    const graph = captureProfileRuntimes(
      captureAgentProfiles(root),
      captureTools([]),
      '',
    );
    expect(
      (graph.roster[0]!.model as { request_controls: object }).request_controls,
    ).toHaveProperty('hosted_prompt.reference.id', 'pmpt_root');
    expect(
      (graph.roster[1]!.model as { request_controls: object }).request_controls,
    ).toHaveProperty('hosted_prompt', null);
  });
});

// Controlled provider acquisition proves rejection before native startup.
it('rejects saved prompt authority before acquiring the native provider', async () => {
  const { NativeProvider } = await import('../src/runtime/provider');
  const { CODEX_REVISION } = await import('../src/runtime/state');
  const provider = new NativeProvider({ apiKey: 'test' });
  const acquire = vi.spyOn(provider, '_acquire');
  const agent = new Agent({
    instructions: 'Application instructions',
    provider,
  });
  const state = {
    format_version: 2 as const,
    codex_revision: CODEX_REVISION,
    source_session_id: 'root',
    root_metadata: {},
    history: [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
        metadata: {
          sdk_agent_profile: {
            profile_id: 'agent_0',
            epoch: 1,
            model: {
              model: 'gpt-5',
              request_controls: {
                hosted_prompt: {
                  reference: { id: 'pmpt_untrusted' },
                  omit_model: true,
                  omit_instructions: true,
                  omit_tools: true,
                },
              },
            },
          },
        },
      },
    ],
  };
  await expect(agent.session({ state })).rejects.toThrow(
    'Stored hosted prompt references are not authorized',
  );
  expect(acquire).not.toHaveBeenCalled();
  acquire.mockRestore();
});
