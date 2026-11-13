import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  HostedResponsesWebSocketModel,
  type ModelSettings,
} from '../../src';

const denied: [string, ModelSettings][] = [
  ['max_tool_calls', { extraBody: { max_tool_calls: 1 } }],
  ['reasoning.summary', { reasoningSummary: 'concise' }],
  ['multi_agent', { extraBody: { multi_agent: { enabled: false } } }],
  ['null multi_agent', { extraBody: { multi_agent: null } }],
  ['betas', { extraBody: { betas: ['synthetic'] } }],
  ['null betas', { extraBody: { betas: null } }],
];
it.each(denied)(
  'rejects unsupported hosted %s before factory I/O',
  async (_name, settings) => {
    let opens = 0;
    const backend = new HostedResponsesWebSocketModel(() => {
      opens++;
      throw new Error('synthetic factory boundary');
    }, 'gpt-5.5');
    await using provider = new NativeProvider({ modelBackend: backend });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      modelSettings: { ...settings, retry: { maxRetries: 0 } },
    });
    await expect(agent.run('Hello.')).rejects.toThrow(/Hosted Responses/);
    expect(opens).toBe(0);
  },
);
it.each([
  ['gpt-5.5', {}],
  ['gpt-4.1', { reasoningSummary: 'none' }],
  ['gpt-5.5', { extraBody: { max_tool_calls: null } }],
] as const)(
  'keeps supported hosted options for %s',
  async (model, settings) => {
    let opens = 0;
    const backend = new HostedResponsesWebSocketModel(() => {
      opens++;
      throw new Error('synthetic factory boundary');
    }, model);
    await using provider = new NativeProvider({ modelBackend: backend });
    const agent = new Agent({
      provider,
      model,
      instructions: 'Answer.',
      modelSettings: { ...settings, retry: { maxRetries: 0 } },
    });
    await expect(agent.run('Hello.')).rejects.toThrow(
      /synthetic factory boundary/,
    );
    expect(opens).toBe(1);
  },
);
