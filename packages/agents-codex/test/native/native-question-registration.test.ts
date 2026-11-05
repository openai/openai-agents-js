import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

it('excludes unselected native questions and independently unselected messages from root registration and dispatch', async () => {
  const execute = vi.fn(() => 'must not run');
  const onNativeQuestion = vi.fn(() => {
    throw new Error('An unselected tool must not request a question grant.');
  });
  const unselected = [
    'request_user_input',
    'request_user_input_async',
    'send_user_message_async',
    'send_message_to_user_async',
  ];
  const model = new ModelServer([
    // Empty arguments probe unregistered names, not enabled question schemas.
    unselected.map((name) => call(name, {}, { callId: name })),
    [message('All unselected calls were refused.')],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Use only the application-selected tools.',
    provider,
    tools: [tool({ name: 'probe', parameters: z.strictObject({}), execute })],
  });
  // Agent.run joins its Session before provider disposal and model closure.
  expect(
    (await agent.run('Probe the unselected names.', { onNativeQuestion }))
      .finalOutput,
  ).toBe('All unselected calls were refused.');
  expect(model.requests).toHaveLength(2);
  for (const request of model.requests) {
    expect(request.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'probe' }),
    ]);
    for (const item of request.input as JsonObject[])
      expect(item.type).not.toBe('additional_tools');
  }
  const outputs = (model.requests[1]!.input as JsonObject[]).filter(
    (item) => item.type === 'function_call_output',
  );
  for (const name of unselected)
    expect(outputs.find((item) => item.call_id === name)?.output).toBe(
      `unsupported call: ${name}`,
    );
  expect(onNativeQuestion).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  model.assertExhausted();
}, 20_000);
