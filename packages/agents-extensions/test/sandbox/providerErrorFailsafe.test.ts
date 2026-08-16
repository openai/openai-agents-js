import { describe, expect, it } from 'vitest';
import { SandboxProviderError } from '@openai/agents-core/sandbox';
import {
  assertResumeRecreateAllowed,
  providerErrorDetails,
  providerErrorMessage,
  providerErrorRetryability,
  withProviderError,
} from '../../src/sandbox/shared';

function hostileProviderError(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new Error('provider metadata trap');
      },
      getPrototypeOf() {
        throw new Error('provider prototype trap');
      },
    },
  );
}

describe('sandbox provider error inspection', () => {
  it('keeps diagnostic helpers fail-safe for hostile provider errors', () => {
    const error = hostileProviderError();

    expect(providerErrorMessage(error)).toBe(
      'Provider error could not be inspected safely.',
    );
    expect(providerErrorDetails(error)).toEqual({});
    expect(providerErrorRetryability(error)).toBeNull();
  });

  it('wraps hostile provider failures as SandboxProviderError', async () => {
    const providerFailure = hostileProviderError();
    let thrown: unknown;

    try {
      await withProviderError(
        'ProviderSandboxClient',
        'provider',
        'create sandbox',
        async () => {
          throw providerFailure;
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as Error).message).toContain(
      'Provider error could not be inspected safely.',
    );
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'provider',
      operation: 'create sandbox',
      retryable: null,
      cause: 'Provider error could not be inspected safely.',
    });
  });

  it('keeps hostile resume failures inside the provider error boundary', () => {
    expect(() =>
      assertResumeRecreateAllowed(hostileProviderError(), {
        providerName: 'ProviderSandboxClient',
        provider: 'provider',
      }),
    ).toThrow(SandboxProviderError);
  });
});
