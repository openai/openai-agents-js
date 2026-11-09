import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import * as agents from '@openai/agents';
import * as codex from '../src';
import {
  Agent,
  DecisionError,
  OutputValidationError,
  type DecisionProvider,
  type DecisionRequest,
} from '../src';
import { bindDecide } from '../src/runtime/decisions';
import type { TokenUsage } from '../src/runtime/run-events';

const usage: TokenUsage = {
  inputTokens: 7,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 0,
  outputTokens: 3,
  reasoningOutputTokens: 0,
  totalTokens: 10,
};
function provider(value: unknown): DecisionProvider {
  return {
    getDecision: vi.fn(async () => ({
      value,
      usage,
      requestId: 'request-1',
      model: 'resolved',
    })),
  };
}

describe('provider-agnostic decisions', () => {
  it('returns a boolean through the existing native-output wrapper', async () => {
    const selected = provider({ response: true });
    const result = new Agent({ instructions: 'Answer.' }).decide(
      'Is this ready?',
      {
        provider: selected,
        input: 'Ready.',
      },
    );
    expectTypeOf(result).toEqualTypeOf<Promise<boolean>>();
    await expect(result).resolves.toBe(true);
    expect(selected.getDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'Is this ready?',
        input: 'Ready.',
        outputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            response: expect.objectContaining({ type: 'boolean' }),
          }),
        }),
      }),
      { signal: undefined },
    );
  });

  it('preserves distinct scalar choices and their inferred type', async () => {
    const result = new Agent({ instructions: 'Answer.' }).decide('Choose.', {
      provider: provider({ response: false }),
      input: 'Text.',
      choices: [false, 'false', 0, null] as const,
    });
    expectTypeOf(result).toEqualTypeOf<Promise<false | 'false' | 0 | null>>();
    await expect(result).resolves.toBe(false);
  });

  it('validates typed records without an internal wrapper in provider output', async () => {
    const result = new Agent({ instructions: 'Answer.' }).decide('Classify.', {
      provider: provider({ category: 'support' }),
      input: [],
      outputType: z.strictObject({ category: z.enum(['sales', 'support']) }),
    });
    expectTypeOf(result).toEqualTypeOf<
      Promise<{ category: 'sales' | 'support' }>
    >();
    await expect(result).resolves.toEqual({ category: 'support' });
  });

  it('captures explicit messages before the provider suspends', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let request: DecisionRequest | undefined;
    const selected: DecisionProvider = {
      getDecision: async (captured) => {
        request = captured;
        entered.resolve();
        await release.promise;
        return { value: { response: true } };
      },
    };
    const input = [{ role: 'user', content: 'original' }];
    const result = new Agent({ instructions: 'Answer.' }).decide('Ready?', {
      provider: selected,
      input,
    });
    await entered.promise;
    input[0].content = 'later';
    release.resolve();
    await result;
    expect(request!.input).toEqual([{ role: 'user', content: 'original' }]);
  });

  it('records known completion metadata before validation failure', async () => {
    const record = vi.fn(async () => {});
    const bound = bindDecide({
      provider: provider({ response: 'invalid' }),
      assertActive() {},
      own: (work) => work(),
      record,
    });
    await expect(bound('Ready?', { input: 'Text.' })).rejects.toBeInstanceOf(
      OutputValidationError,
    );
    expect(record).toHaveBeenCalledExactlyOnceWith({
      usage,
      requestId: 'request-1',
      model: 'resolved',
    });
  });

  it('retains completed refusal metadata and leaves transport failures unrecorded', async () => {
    const record = vi.fn(async () => {});
    const refusal = new DecisionError('refusal', {
      usage,
      requestId: 'request-refusal',
    });
    const selected: DecisionProvider = {
      getDecision: vi.fn(async () => {
        throw refusal;
      }),
    };
    const bound = bindDecide({
      provider: selected,
      assertActive() {},
      own: (work) => work(),
      record,
    });
    await expect(bound('Ready?', { input: 'Text.' })).rejects.toBe(refusal);
    expect(record).toHaveBeenCalledTimes(1);
    const network = new Error('Synthetic transport failure');
    vi.mocked(selected.getDecision).mockRejectedValueOnce(network);
    await expect(bound('Ready?', { input: 'Text.' })).rejects.toBe(network);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('permits a per-call provider override without changing the default', async () => {
    const original = provider({ response: false }),
      override = provider({ response: true });
    const bound = bindDecide({
      provider: original,
      assertActive() {},
      own: (work) => work(),
      record: async () => {},
    });
    await expect(
      bound('Ready?', { provider: override, input: 'Text.' }),
    ).resolves.toBe(true);
    await expect(bound('Ready?', { input: 'Text.' })).resolves.toBe(false);
  });

  it('does not expose response data in errors and treats invalid usage as unknown', async () => {
    const selected: DecisionProvider = {
      getDecision: async () => ({
        value: { response: NaN, private: 'PRIVATE_RESPONSE' },
        usage: { ...usage, totalTokens: 99 },
      }),
    };
    const failure = await new Agent({ instructions: 'Answer.' })
      .decide('Ready?', {
        provider: selected,
        input: 'Text.',
      })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(DecisionError);
    expect(failure.usage).toBeUndefined();
    expect(String(failure)).not.toContain('PRIVATE_RESPONSE');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_RESPONSE');
  });
});

it('rejects non-finite provider values before they can coerce to valid null output', async () => {
  await expect(
    new Agent({ instructions: 'Answer.' }).decide('Null?', {
      provider: provider({ response: NaN }),
      input: 'Explicit.',
      outputType: z.null(),
    }),
  ).rejects.toMatchObject({ reason: 'invalid_response', usage });
});

it('binds Agent.decide without opening a generative session and requires a configured provider', async () => {
  const configured = provider({ response: true });
  const agent = new Agent({ instructions: 'Answer.', decisions: configured });
  const session = vi.spyOn(agent, 'session');
  await expect(agent.decide('Ready?', { input: 'Explicit.' })).resolves.toBe(
    true,
  );
  expect(session).not.toHaveBeenCalled();
  agent.decisions = undefined;
  await expect(agent.decide('Ready?', { input: 'Explicit.' })).rejects.toThrow(
    'provider is required',
  );
  await expect(
    agent.decide('Ready?', { input: 'Explicit.', provider: configured }),
  ).resolves.toBe(true);
});

it('retains refusal metadata when accounting also fails', async () => {
  const primary = new DecisionError('refusal', {
    usage,
    requestId: 'refused-request',
    model: 'resolved',
  });
  const accounting = new Error('Synthetic accounting failure');
  const bound = bindDecide({
    provider: {
      getDecision: async () => {
        throw primary;
      },
    },
    assertActive() {},
    own: (work) => work(),
    record: async () => {
      throw accounting;
    },
  });
  const failure = await bound('Ready?', { input: 'Explicit.' }).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.cause).toBe(primary);
  expect(failure.errors).toEqual([primary, accounting]);
  expect(failure.errors[0]).toMatchObject({
    usage,
    requestId: 'refused-request',
    model: 'resolved',
  });
});
it('propagates a lone accounting failure unchanged after successful inference', async () => {
  const accounting = new Error('Synthetic accounting failure');
  const record = vi.fn(async () => {
    throw accounting;
  });
  const bound = bindDecide({
    provider: provider({ response: true }),
    assertActive() {},
    own: (work) => work(),
    record,
  });
  await expect(bound('Ready?', { input: 'Explicit.' })).rejects.toBe(
    accounting,
  );
  expect(record).toHaveBeenCalledExactlyOnceWith({
    usage,
    requestId: 'request-1',
    model: 'resolved',
  });
});

it('exposes decisions only through Agents and callback contexts', () => {
  expect(agents).not.toHaveProperty('decide');
  expect(codex).not.toHaveProperty('decide');
  expect(new agents.OpenAIDecisions()).not.toHaveProperty('decide');
});
