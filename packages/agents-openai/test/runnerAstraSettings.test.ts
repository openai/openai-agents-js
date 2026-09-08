import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { Agent, Runner, setTracingDisabled } from '@openai/agents-core';
import type { ModelSettings } from '@openai/agents-core';
import { OpenAIProvider } from '../src/openaiProvider';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import logger from '../src/logger';

describe('Runner GPT-5-and-newer settings', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_DEFAULT_MODEL', 'gpt-5.6-luna');
    setTracingDisabled(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const cases: {
    name: string;
    settings?: ModelSettings;
    model?: string;
    modelSource?: 'agent-instance' | 'runner-instance' | 'runner-name';
    prompt?: Agent['prompt'];
    runnerSettings?: ModelSettings;
    defaultModel?: string;
    expectedVerbosity?: string;
    expectedReasoning?: Record<string, unknown>;
  }[] = [
    ...(['low', 'high'] as const).map((effort) => ({
      name: `provider reasoning ${effort}`,
      settings: { providerData: { reasoning: { effort, summary: 'auto' } } },
      expectedReasoning: { effort, summary: 'auto' },
    })),
    {
      name: 'mixed reasoning with provider overrides',
      settings: {
        reasoning: { effort: 'high', summary: 'auto', mode: 'pro' },
        providerData: { reasoning: { effort: 'low' } },
      },
      expectedReasoning: { effort: 'low', summary: 'auto', mode: 'pro' },
    },
    {
      name: 'Astra defaults',
      expectedReasoning: { effort: 'low' },
      expectedVerbosity: 'low',
    },
    {
      name: 'Astra environment defaults',
      defaultModel: 'gpt-6-astra',
      expectedReasoning: { effort: 'low' },
      expectedVerbosity: 'low',
    },
    {
      name: 'explicit reasoning without a registered default',
      model: 'gpt-5-mini',
      settings: {
        providerData: { reasoning: { effort: 'high', summary: 'auto' } },
      },
      expectedReasoning: { effort: 'high', summary: 'auto' },
    },
    {
      name: 'shared defaults without an invented effort',
      model: 'gpt-5-mini',
      expectedVerbosity: 'low',
    },
    {
      name: 'legacy cleanup with an Astra environment default',
      model: 'gpt-4.1',
      defaultModel: 'gpt-6-astra',
      settings: { providerData: { reasoning: { effort: 'low' } } },
    },
    {
      name: 'stored prompt model defaults',
      defaultModel: 'gpt-6-astra',
      prompt: { promptId: 'pmpt_legacy' },
    },
    {
      name: 'dynamic stored prompt model defaults',
      defaultModel: 'gpt-6-astra',
      prompt: async () => ({ promptId: 'pmpt_legacy' }),
    },
    {
      name: 'explicit agent settings for a prompt-owned model',
      defaultModel: 'gpt-6-astra',
      prompt: { promptId: 'pmpt_reasoning' },
      settings: { providerData: { reasoning: { effort: 'high' } } },
      expectedReasoning: { effort: 'high' },
    },
    {
      name: 'explicit runner settings for a prompt-owned model',
      defaultModel: 'gpt-6-astra',
      prompt: { promptId: 'pmpt_reasoning' },
      runnerSettings: { reasoning: { effort: 'high' } },
      expectedReasoning: { effort: 'high' },
    },
    {
      name: 'agent model override of a stored prompt',
      model: 'gpt-6-astra',
      prompt: { promptId: 'pmpt_legacy' },
      expectedReasoning: { effort: 'low' },
      expectedVerbosity: 'low',
    },
    {
      name: 'runner model override of a stored prompt',
      model: 'gpt-6-astra',
      modelSource: 'runner-name',
      prompt: { promptId: 'pmpt_legacy' },
      expectedReasoning: { effort: 'low' },
      expectedVerbosity: 'low',
    },
    {
      name: 'concrete instance without implicit defaults',
      modelSource: 'agent-instance',
      model: 'gpt-6-astra',
      defaultModel: 'gpt-6-astra',
    },
    ...(['agent-instance', 'runner-instance'] as const).map((modelSource) => ({
      name: `explicit settings for a concrete ${modelSource}`,
      modelSource,
      model: 'gpt-6-astra',
      defaultModel: 'gpt-6-astra',
      settings: {
        providerData: { reasoning: { effort: 'high', summary: 'auto' } },
      },
      expectedReasoning: { effort: 'high', summary: 'auto' },
    })),
  ];

  describe.each([false, true])('stream=%s', (stream) => {
    it.each(cases)(
      'preserves $name',
      async ({
        settings,
        expectedReasoning,
        model,
        modelSource,
        prompt,
        runnerSettings,
        defaultModel,
        expectedVerbosity,
      }) => {
        if (defaultModel) vi.stubEnv('OPENAI_DEFAULT_MODEL', defaultModel);
        const selectedModel =
          model ?? (defaultModel ? undefined : 'gpt-6-astra');
        const originalSettings = structuredClone(settings);
        const originalRunnerSettings = structuredClone(runnerSettings);
        const promptCallback =
          typeof prompt === 'function' ? vi.fn(prompt) : undefined;
        const bodies: Record<string, any>[] = [];
        const response = {
          id: 'resp_astra',
          object: 'response',
          status: 'completed',
          output: [
            {
              id: 'msg_astra',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '391', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        // Exercise client serialization; a ScriptedModel bypasses the provider wire boundary.
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
        const configuredModel = modelSource?.endsWith('instance')
          ? new OpenAIResponsesModel(client, selectedModel!)
          : selectedModel;
        const modelOnRunner = modelSource?.startsWith('runner');
        const runner = new Runner({
          model: modelOnRunner ? configuredModel : undefined,
          modelSettings: runnerSettings,
          modelProvider: new OpenAIProvider({ openAIClient: client }),
          tracingDisabled: true,
        });
        const agent = new Agent({
          name: 'Astra',
          model: modelOnRunner ? undefined : configuredModel,
          prompt: promptCallback ?? prompt,
          modelSettings: settings,
        });

        const result = stream
          ? await runner.run(agent, 'What is 17 * 23?', { stream: true })
          : await runner.run(agent, 'What is 17 * 23?');
        if ('completed' in result) {
          await result.completed;
        }
        expect(result.finalOutput).toBe('391');
        expect(bodies).toHaveLength(1);
        expect(bodies[0].model).toBe(
          prompt && !selectedModel
            ? undefined
            : (selectedModel ?? defaultModel),
        );
        if (prompt) expect(bodies[0].prompt).toBeDefined();
        if (promptCallback) expect(promptCallback).toHaveBeenCalledTimes(1);
        expect(bodies[0].stream).toBe(stream);
        expect(bodies[0].reasoning).toEqual(expectedReasoning);
        expect(bodies[0].text?.verbosity).toBe(expectedVerbosity);
        expect(settings).toEqual(originalSettings);
        expect(runnerSettings).toEqual(originalRunnerSettings);
      },
    );
  });
  it.each([false, true])(
    'keeps defaults when Chat Completions ignores a prompt (stream=%s)',
    async (stream) => {
      const bodies: Record<string, any>[] = [];
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const message = { role: 'assistant', content: '391' };
      // Capture client serialization for the adapter that ignores reusable prompts.
      const client = new OpenAI({
        apiKey: 'test-key',
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(init!.body as string));
          const response = {
            id: 'chatcmpl_prompt',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-5.6-luna',
            choices: [{ index: 0, message, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
          const chunk = {
            ...response,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: message, finish_reason: 'stop' }],
          };
          return new Response(
            stream
              ? `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
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
        modelProvider: new OpenAIProvider({
          openAIClient: client,
          useResponses: false,
        }),
        tracingDisabled: true,
      });
      const agent = new Agent({
        name: 'Chat prompt',
        prompt: { promptId: 'pmpt_legacy' },
      });
      const result = stream
        ? await runner.run(agent, 'What is 17 * 23?', { stream: true })
        : await runner.run(agent, 'What is 17 * 23?');
      if ('completed' in result) await result.completed;
      expect(result.finalOutput).toBe('391');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        model: 'gpt-5.6-luna',
        reasoning_effort: 'none',
        verbosity: 'low',
        stream,
      });
      expect(bodies[0]).not.toHaveProperty('prompt');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring prompt'),
      );
    },
  );
});
