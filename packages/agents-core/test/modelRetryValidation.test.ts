import { beforeAll, describe, expect, it } from 'vitest';
import {
  Agent,
  run,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src';
import { validateModelMaxRetries } from '../src/runner/modelRetry';
import { ScriptedModel, modelResponse } from '../src/testing';
import { Usage } from '../src/usage';
import { fakeModelMessage, ScriptedModelProvider } from './stubs';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());
});

describe('model retry count validation', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxRetries value %s',
    (maxRetries) => {
      expect(() =>
        validateModelMaxRetries({ retry: { maxRetries } }),
      ).toThrow(
        'modelSettings.retry.maxRetries must be a non-negative finite integer when provided.',
      );
    },
  );

  it.each([0, 1, 3])('accepts bounded integer maxRetries %s', (maxRetries) => {
    expect(validateModelMaxRetries({ retry: { maxRetries } })).toBe(maxRetries);
  });

  it('defaults maxRetries to zero', () => {
    expect(validateModelMaxRetries({})).toBe(0);
  });

  it('fails before starting a model request for invalid retry counts', async () => {
    const model = new ScriptedModel([
      modelResponse({
        output: [fakeModelMessage('should not run')],
        usage: new Usage(),
      }),
    ]);
    const agent = new Agent({
      name: 'InvalidRetryCountAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: Number.NaN,
          policy: () => true,
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow(
      'modelSettings.retry.maxRetries must be a non-negative finite integer when provided.',
    );
    expect(model.calls).toHaveLength(0);
  });
});
