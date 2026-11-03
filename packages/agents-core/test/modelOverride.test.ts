import { describe, expect, it, vi } from 'vitest';
import {
  Agent,
  Runner,
  RunContext,
  UserError,
  handoff,
  type RunConfig,
} from '../src';
import { Capability, SandboxAgent, prepareSandboxAgent } from '../src/sandbox';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
  scriptedSandboxSession,
} from '../src/testing';

class ModelSelectionCapability extends Capability {
  readonly type = 'model-selection-probe';

  get boundModel() {
    return this._modelInstance;
  }

  override samplingParams(parameters: Record<string, unknown>) {
    return { observedModelName: parameters.model };
  }
}

describe('explicit run model override', () => {
  it('preserves explicit Agent models and settings when the override is absent', async () => {
    const selected = new ScriptedModel([
      modelResponse([assistantMessage('original')]),
    ]);
    const fallback = new ScriptedModel([
      modelResponse([assistantMessage('default')]),
    ]);
    const context = { account: 'synthetic' };
    const seenContexts: unknown[] = [];
    const agent = new Agent({
      name: 'explicit',
      model: selected,
      modelSettings: { temperature: 0.2 },
      instructions: (runContext) => {
        seenContexts.push(runContext.context);
        return 'Use the configured model.';
      },
    });
    const settings = agent.modelSettings;
    const config = {
      model: fallback,
      modelSettings: { temperature: 0.8, maxTokens: 25 },
      tracingDisabled: true,
    };
    const result = await new Runner(config).run(agent, 'input', { context });

    expect(result.finalOutput).toBe('original');
    expect(selected.calls[0].request.modelSettings).toMatchObject({
      temperature: 0.2,
      maxTokens: 25,
    });
    expect(fallback.calls).toHaveLength(0);
    expect(agent.model).toBe(selected);
    expect(agent.modelSettings).toBe(settings);
    expect(config.model).toBe(fallback);
    expect(config.modelSettings).toEqual({ temperature: 0.8, maxTokens: 25 });
    expect(seenContexts).toEqual([context]);
    expect(seenContexts[0]).toBe(context);
  });

  it('preserves the run default for an Agent without an explicit model', async () => {
    const fallback = new ScriptedModel([
      modelResponse([assistantMessage('default')]),
    ]);
    const result = await new Runner({
      model: fallback,
      tracingDisabled: true,
    }).run(new Agent({ name: 'default' }), 'input');

    expect(result.finalOutput).toBe('default');
    expect(fallback.calls).toHaveLength(1);
  });

  it('treats a run override as explicit when a prompt can select its model', async () => {
    const selected = Object.assign(
      new ScriptedModel([modelResponse([assistantMessage('selected')])]),
      { supportsPromptModelSelection: true },
    );
    const agent = new Agent({
      name: 'prompted',
      prompt: { promptId: 'synthetic_prompt' },
    });
    const result = await new Runner({
      modelOverride: selected,
      tracingDisabled: true,
    }).run(agent, 'Hello');

    expect(result.finalOutput).toBe('selected');
    expect(selected.calls[0].request.prompt).toEqual({
      promptId: 'synthetic_prompt',
    });
    expect(selected.calls[0].request.overridePromptModel).toBe(true);
  });

  it.each([
    { kind: 'name', stream: false },
    { kind: 'implementation', stream: false },
    { kind: 'implementation', stream: true },
  ] as const)(
    'uses the $kind override across an actual handoff (stream=$stream)',
    async ({ kind, stream }) => {
      const context = { account: 'synthetic' };
      const seenContexts: unknown[] = [];
      const targetModel = new ScriptedModel([
        modelResponse([assistantMessage('original target')]),
      ]);
      const target = new Agent({
        name: 'target',
        model: 'target-model',
        modelSettings: { temperature: 0.6 },
        instructions: (runContext) => {
          seenContexts.push(runContext.context);
          return 'Finish the handoff.';
        },
      });
      const transfer = handoff(target);
      const transferResponse = modelResponse([
        functionCall(transfer.toolName, {}, { callId: 'transfer' }),
      ]);
      const rootModel = new ScriptedModel([transferResponse]);
      const override = new ScriptedModel([
        transferResponse,
        modelResponse([assistantMessage('overridden target')]),
      ]);
      const root = new Agent({
        name: 'root',
        model: 'root-model',
        modelSettings: { temperature: 0.2 },
        instructions: (runContext) => {
          seenContexts.push(runContext.context);
          return 'Transfer to the target.';
        },
        handoffs: [transfer],
      });
      const getModel = vi.fn(async (name: string) => {
        if (name === 'root-model') return rootModel;
        if (name === 'target-model') return targetModel;
        if (name === 'override-model') return override;
        throw new Error(`Unexpected model: ${name}`);
      });
      const config: Partial<RunConfig> = {
        modelOverride: kind === 'name' ? 'override-model' : override,
        modelProvider: { getModel },
        modelSettings: { temperature: 0.8 },
        tracingDisabled: true,
      };
      const rootSettings = root.modelSettings;
      const targetSettings = target.modelSettings;
      const runner = new Runner(config);
      const result = await (async () => {
        if (stream) {
          const streamed = await runner.run(root, 'handoff', {
            context,
            stream: true,
          });
          for await (const _event of streamed) {
            // Drain the real Runner stream before inspecting its final result.
          }
          await streamed.completed;
          return streamed;
        }
        return runner.run(root, 'handoff', { context });
      })();

      expect(result.finalOutput).toBe('overridden target');
      expect(result.lastAgent).toBe(target);
      expect(override.calls).toHaveLength(2);
      expect(rootModel.calls).toHaveLength(0);
      expect(targetModel.calls).toHaveLength(0);
      expect(
        override.calls.map((call) => call.request.modelSettings.temperature),
      ).toEqual([0.2, 0.6]);
      expect(getModel.mock.calls.map(([name]) => name)).toEqual(
        kind === 'name' ? ['override-model', 'override-model'] : [],
      );
      expect(root.model).toBe('root-model');
      expect(target.model).toBe('target-model');
      expect(root.modelSettings).toBe(rootSettings);
      expect(target.modelSettings).toBe(targetSettings);
      expect(config.modelSettings).toEqual({ temperature: 0.8 });
      expect(seenContexts).toHaveLength(2);
      expect(seenContexts.every((value) => value === context)).toBe(true);
      expect(config.modelOverride).toBe(
        kind === 'name' ? 'override-model' : override,
      );
    },
  );

  it.each(['', '   ', null, 42, {}, { getResponse() {} }])(
    'rejects an invalid override before provider or model work: %j',
    (value) => {
      const getModel = vi.fn();
      const config = {
        modelOverride: value,
        modelProvider: { getModel },
      } as unknown as Partial<RunConfig>;
      expect(() => new Runner(config)).toThrow(UserError);
      expect(getModel).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps nested Agent tools separately configured (explicit opt-in=%s)',
    async (optIn) => {
      const original = new ScriptedModel([
        modelResponse([assistantMessage('original child')]),
      ]);
      const selected = new ScriptedModel([
        modelResponse([assistantMessage('selected child')]),
      ]);
      const parentModel = new ScriptedModel([
        modelResponse([assistantMessage('parent')]),
      ]);
      const child = new Agent({
        name: 'child',
        model: optIn ? 'original-child' : original,
      });
      const childTool = child.asTool({
        toolDescription: 'Invoke the child.',
        ...(optIn ? { runConfig: { modelOverride: selected } } : {}),
      });
      const parent = new Runner({
        modelOverride: parentModel,
        modelSettings: {
          providerData: {
            extraHeaders: { 'x-synthetic': 'parent' },
            extraQuery: { route: 'parent' },
            retained: 'setting',
          },
        },
        tracingDisabled: true,
      });
      const output = await childTool.invoke(
        new RunContext(),
        JSON.stringify({ input: 'child input' }),
        { parentRunConfig: parent.config },
      );
      const active = optIn ? selected : original;

      expect(output).toBe(optIn ? 'selected child' : 'original child');
      expect(active.calls).toHaveLength(1);
      expect(active.calls[0].request.modelSettings.providerData).toEqual({
        retained: 'setting',
      });
      expect(parentModel.calls).toHaveLength(0);
      expect(child.model).toBe(optIn ? 'original-child' : original);
      expect(parent.config.modelOverride).toBe(parentModel);
      expect(parent.config.modelSettings?.providerData).toHaveProperty(
        'extraHeaders',
        { 'x-synthetic': 'parent' },
      );
    },
  );

  it.each(['name', 'implementation'] as const)(
    'preserves the %s override through Sandbox model preparation',
    (kind) => {
      const selected = new ScriptedModel();
      const agent = new SandboxAgent({
        name: 'sandbox',
        model: 'original-sandbox',
        capabilities: [new ModelSelectionCapability()],
      });
      const session = scriptedSandboxSession();
      const prepared = prepareSandboxAgent({
        agent,
        session,
        runConfigModel:
          kind === 'name'
            ? { model: 'selected-sandbox', modelInstance: selected }
            : selected,
        runConfigModelOverride: kind === 'name' ? 'selected-sandbox' : selected,
      });
      const capability = prepared.capabilities.find(
        (entry) => entry instanceof ModelSelectionCapability,
      );

      expect(capability?.boundModel).toBe(selected);
      if (kind === 'name') {
        expect(prepared.modelSettings.providerData).toHaveProperty(
          'observedModelName',
          'selected-sandbox',
        );
      }
      expect(agent.model).toBe('original-sandbox');
      session.assertComplete();
    },
  );
});
