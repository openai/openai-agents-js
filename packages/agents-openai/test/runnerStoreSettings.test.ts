import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { Agent, Runner, type ModelSettings } from '@openai/agents-core';
import { OpenAIProvider } from '../src/openaiProvider';

describe('Runner storage settings', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_DEFAULT_MODEL', 'gpt-5.6-luna');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const cases: {
    name: string;
    configure: () => Agent;
    runnerSettings?: ModelSettings;
    runnerModel?: string;
    expectedStore?: boolean;
    expectedEffort?: string;
  }[] = [
    {
      name: 'post-construction mutation with resolved model defaults',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = false;
        return agent;
      },
      runnerModel: 'gpt-5',
      expectedStore: false,
      expectedEffort: 'low',
    },
    {
      name: 'post-construction replacement',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings = { store: false };
        return agent;
      },
      expectedStore: false,
      expectedEffort: 'none',
    },
    {
      name: 'inherited clone with recomputed defaults',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = false;
        const clone = agent.clone({ model: 'gpt-4.1' });
        expect(agent.modelSettings.reasoning?.effort).toBe('none');
        expect(clone.modelSettings).toEqual({ store: false });
        return clone;
      },
      expectedStore: false,
    },
    {
      name: 'clone of replaced settings',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings = { store: false };
        return agent.clone({ name: 'Clone' }).clone({ name: 'Second clone' });
      },
      expectedStore: false,
      expectedEffort: 'none',
    },
    {
      name: 'constructor storage policy',
      configure: () =>
        new Agent({ name: 'Private', modelSettings: { store: false } }),
      expectedStore: false,
    },
    {
      name: 'runner policy with absent agent store',
      configure: () => new Agent({ name: 'Private' }),
      runnerSettings: { store: false },
      expectedStore: false,
      expectedEffort: 'none',
    },
    {
      name: 'agent policy overrides runner policy',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = false;
        return agent;
      },
      runnerSettings: { store: true },
      expectedStore: false,
      expectedEffort: 'none',
    },
    {
      name: 'explicit undefined store overrides runner policy through cloning',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = undefined;
        return agent.clone({ name: 'Clone' });
      },
      runnerSettings: { store: false },
      expectedEffort: 'none',
    },
    {
      name: 'explicit clone reset',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = false;
        return agent.clone({ modelSettings: undefined });
      },
      expectedEffort: 'none',
    },
    {
      name: 'explicit clone replacement',
      configure: () => {
        const agent = new Agent({ name: 'Private' });
        agent.modelSettings.store = false;
        return agent.clone({ modelSettings: { store: true } });
      },
      expectedStore: true,
    },
    {
      name: 'prompt-selected model without generated defaults',
      configure: () => {
        const agent = new Agent({
          name: 'Private',
          prompt: { promptId: 'pmpt_test' },
        });
        agent.modelSettings.store = false;
        return agent;
      },
      expectedStore: false,
    },
  ];

  describe.each([false, true])('stream=%s', (stream) => {
    it.each(cases)(
      'preserves $name',
      async ({
        configure,
        runnerSettings,
        runnerModel,
        expectedStore,
        expectedEffort,
      }) => {
        const bodies: Record<string, any>[] = [];
        const response = {
          id: 'resp_store',
          object: 'response',
          status: 'completed',
          output: [
            {
              id: 'msg_store',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: 'Synthetic reply',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        // Capture real client serialization; ScriptedModel bypasses this wire boundary.
        const client = new OpenAI({
          apiKey: 'test-key',
          fetch: async (_url, init) => {
            bodies.push(JSON.parse(init!.body as string));
            return new Response(
              stream
                ? `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', sequence_number: 0, response })}\n\n`
                : JSON.stringify(response),
              {
                headers: {
                  'content-type': stream
                    ? 'text/event-stream'
                    : 'application/json',
                },
              },
            );
          },
        });
        const runner = new Runner({
          model: runnerModel,
          modelSettings: runnerSettings,
          modelProvider: new OpenAIProvider({ openAIClient: client }),
          tracingDisabled: true,
        });
        const agent = configure();
        const originalSettings = structuredClone(agent.modelSettings);
        const result = stream
          ? await runner.run(agent, 'Synthetic input', { stream: true })
          : await runner.run(agent, 'Synthetic input');
        if ('completed' in result) await result.completed;
        expect(result.finalOutput).toBe('Synthetic reply');
        expect(bodies).toHaveLength(1);
        expect(bodies[0].store).toBe(expectedStore);
        expect(Object.prototype.hasOwnProperty.call(bodies[0], 'store')).toBe(
          expectedStore !== undefined,
        );
        expect(bodies[0].reasoning?.effort).toBe(expectedEffort);
        expect(agent.modelSettings).toEqual(originalSettings);
      },
    );
  });
});
