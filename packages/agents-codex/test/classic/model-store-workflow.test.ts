import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  OpenAIConversationsSession,
  RunContext,
  Runner,
  tool,
  Usage,
  type Model,
  type ModelProvider,
  type ModelRequest,
} from '@openai/agents/classic';
import {
  assistantMessage,
  functionCall,
  modelResponse,
  ScriptedModel,
} from '@openai/agents/classic/testing';
import { modelStoreHttp } from './fixtures/model-store-http';

describe('public classic Model and persistent Session workflow', () => {
  it('selects the Model, persists one effect, and replays ordered history through fresh owners', async () => {
    const fixture = await modelStoreHttp();
    try {
      const context = { account: 'application-context' };
      let effects = 0;
      let toolContext: RunContext | undefined;
      let runUsage: Usage | undefined;
      const remember = tool({
        name: 'remember',
        description: 'Remember one value.',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }, current) => {
          expect(current?.context).toBe(context);
          toolContext = current;
          effects += 1;
          return `remembered ${value}`;
        },
      });
      const firstModel = new ScriptedModel([
        modelResponse({
          output: [
            functionCall(
              'remember',
              { value: 'hello' },
              { callId: 'remember-once' },
            ),
          ],
          usage: new Usage({ inputTokens: 2, outputTokens: 1 }),
          responseId: 'tool-response',
        }),
        modelResponse({
          output: [assistantMessage('remembered hello')],
          usage: new Usage({ inputTokens: 3, outputTokens: 2 }),
          responseId: 'first-response',
        }),
      ]);
      const selected: Model[] = [];
      const provider = (model: Model): ModelProvider => ({
        getModel(name) {
          expect(name).toBe('selected-store-model');
          selected.push(model);
          return model;
        },
      });
      const session = () =>
        new OpenAIConversationsSession({
          conversationId: fixture.conversationId,
          apiKey: 'fixture-key',
          baseURL: fixture.baseURL,
        });
      const agent = new Agent<typeof context>({
        name: 'classic-store',
        model: 'selected-store-model',
        instructions: (current) => `Help ${current.context.account}.`,
        tools: [remember],
      });
      const firstSession = session();
      const firstRunner = new Runner({
        modelProvider: provider(firstModel),
        tracingDisabled: true,
      });
      firstRunner.on('agent_start', (current) => {
        expect(current.context).toBe(context);
        runUsage = current.usage;
      });
      const first = await firstRunner.run(agent, 'remember hello', {
        session: firstSession,
        context,
      });
      expect(first.finalOutput).toBe('remembered hello');
      expect(first.lastAgent).toBe(agent);
      expect(toolContext).toBeInstanceOf(RunContext);
      expect(toolContext?.usage).toBe(runUsage);
      expect(runUsage).toBeInstanceOf(Usage);
      expect(runUsage).toMatchObject({
        requests: 2,
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      });
      const stored = await firstSession.getItems();
      expect(stored.map((item) => item.type)).toEqual([
        'message',
        'function_call',
        'function_call_result',
        'message',
      ]);
      expect(stored[1]).toMatchObject({
        name: 'remember',
        callId: 'remember-once',
        arguments: '{"value":"hello"}',
      });
      expect(stored[2]).toMatchObject({
        callId: 'remember-once',
        output: 'remembered hello',
      });

      const nextModel = new ScriptedModel([
        modelResponse({
          output: [assistantMessage('continued')],
          usage: new Usage({ inputTokens: 7, outputTokens: 4 }),
          responseId: 'continued-response',
        }),
      ]);
      const nextSession = session();
      const nextRunner = new Runner({
        modelProvider: provider(nextModel),
        tracingDisabled: true,
      });
      let nextUsage: Usage | undefined;
      nextRunner.on('agent_end', (current) => {
        nextUsage = current.usage;
      });
      const continued = await nextRunner.run(agent, 'continue', {
        session: nextSession,
        context,
        stream: true,
      });
      const events = [];
      for await (const event of continued) events.push(event);
      await continued.completed;
      expect(continued.finalOutput).toBe('continued');
      expect(
        events.some((event) => event.type === 'raw_model_stream_event'),
      ).toBe(true);
      expect(nextSession).not.toBe(firstSession);
      expect(nextRunner).not.toBe(firstRunner);
      expect(new Set(selected)).toEqual(new Set([firstModel, nextModel]));
      expect(firstModel.calls).toHaveLength(2);
      expect(nextModel.calls).toHaveLength(1);
      expect(nextModel.calls[0].streamed).toBe(true);
      const replay = nextModel.calls[0].request.input;
      expect(replay).toMatchObject([
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'remember hello' }],
        },
        {
          type: 'function_call',
          name: 'remember',
          callId: 'remember-once',
          arguments: '{"value":"hello"}',
        },
        {
          type: 'function_call_result',
          callId: 'remember-once',
          output: 'remembered hello',
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'remembered hello' }],
        },
        { role: 'user', content: 'continue' },
      ]);
      expect(nextModel.calls[0].request.systemInstructions).toBe(
        'Help application-context.',
      );
      expect(nextModel.calls[0].request.conversationId).toBeUndefined();
      expect(nextModel.calls[0].request.previousResponseId).toBeUndefined();
      expect(nextUsage).not.toBe(runUsage);
      expect(nextUsage).toBeInstanceOf(Usage);
      expect(nextUsage).toMatchObject({ requests: 1, totalTokens: 11 });
      expect(effects).toBe(1);
      expect((await nextSession.getItems()).map((item) => item.type)).toEqual([
        'message',
        'function_call',
        'function_call_result',
        'message',
        'message',
        'message',
      ]);
      expect(fixture.items.map((item) => item.type)).toEqual([
        'message',
        'function_call',
        'function_call_output',
        'message',
        'message',
        'message',
      ]);
      expect(fixture.items[2]).toMatchObject({
        call_id: 'remember-once',
        output: 'remembered hello',
      });
      firstModel.assertComplete();
      nextModel.assertComplete();
    } finally {
      await fixture.close();
    }
  });

  it('calls the standalone public Model response and stream contracts with public usage identities', async () => {
    const selected = new ScriptedModel([
      modelResponse({
        output: [assistantMessage('direct')],
        usage: new Usage({ inputTokens: 11, outputTokens: 5 }),
        responseId: 'direct-response',
        requestId: 'direct-request',
      }),
      modelResponse({
        output: [assistantMessage('streamed')],
        usage: new Usage({ inputTokens: 13, outputTokens: 6 }),
        responseId: 'stream-response',
        requestId: 'stream-request',
      }),
    ]);
    const provider: ModelProvider = { getModel: () => selected };
    const model: Model = await provider.getModel('standalone');
    expect(model).toBe(selected);
    const signal = new AbortController().signal;
    const request: ModelRequest = {
      input: 'standalone',
      modelSettings: {},
      tools: [],
      handoffs: [],
      outputType: 'text',
      tracing: false,
      signal,
    };
    const response = await model.getResponse(request);
    expect(response).toMatchObject({
      responseId: 'direct-response',
      requestId: 'direct-request',
      output: [assistantMessage('direct')],
    });
    expect(response.usage).toBeInstanceOf(Usage);
    expect(response.usage).toMatchObject({ requests: 1, totalTokens: 16 });
    const events = [];
    for await (const event of model.getStreamedResponse(request))
      events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      'response_started',
      'output_text_delta',
      'response_done',
    ]);
    expect(events[1]).toMatchObject({ delta: 'streamed' });
    expect(events[2]).toMatchObject({
      response: {
        id: 'stream-response',
        requestId: 'stream-request',
        usage: {
          requests: 1,
          inputTokens: 13,
          outputTokens: 6,
          totalTokens: 19,
        },
      },
    });
    expect(selected.calls.map((call) => call.streamed)).toEqual([false, true]);
    expect(selected.calls.every((call) => call.request.signal === signal)).toBe(
      true,
    );
    selected.assertComplete();
  });
});
