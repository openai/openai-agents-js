import { Runner, type RunConfig } from '@openai/agents-core';
import { OpenAIProvider, type OpenAIProviderOptions } from './openaiProvider';

export type ResponsesWebSocketSessionOptions = {
  /**
   * Options used to construct the session-scoped OpenAI provider.
   */
  providerOptions?: OpenAIProviderOptions;
  /**
   * Runner configuration for the session. modelProvider is controlled by this helper.
   */
  runnerConfig?: Omit<Partial<RunConfig>, 'modelProvider'>;
};

export type ResponsesWebSocketSession = {
  provider: OpenAIProvider;
  runner: Runner;
  run: Runner['run'];
};

function attachCleanupErrorToThrownError(
  callbackError: unknown,
  cleanupError: unknown,
): void {
  if (!(callbackError instanceof Error)) {
    return;
  }

  const callbackErrorWithMetadata = callbackError as Error & {
    cause?: unknown;
    cleanupError?: unknown;
  };

  if (typeof callbackErrorWithMetadata.cause === 'undefined') {
    callbackErrorWithMetadata.cause = cleanupError;
    return;
  }

  callbackErrorWithMetadata.cleanupError = cleanupError;
}

/**
 * Runs a callback within a session-scoped Responses API websocket provider/runner and closes the
 * provider afterwards so websocket connections do not keep the process alive.
 */
export async function withResponsesWebSocketSession<T>(
  callback: (session: ResponsesWebSocketSession) => Promise<T> | T,
  options: ResponsesWebSocketSessionOptions = {},
): Promise<T> {
  const provider = new OpenAIProvider({
    ...(options.providerOptions ?? {}),
    useResponses: true,
    useResponsesWebSocket: true,
  });
  const runner = new Runner({
    ...(options.runnerConfig ?? {}),
    modelProvider: provider,
  });
  const run = runner.run.bind(runner) as Runner['run'];

  let callbackFailed = false;
  let callbackError: unknown;
  let callbackResult!: T;

  try {
    callbackResult = await callback({ provider, runner, run });
  } catch (error) {
    callbackFailed = true;
    callbackError = error;
  }

  try {
    await provider.close();
  } catch (closeError) {
    if (!callbackFailed) {
      throw closeError;
    }
    attachCleanupErrorToThrownError(callbackError, closeError);
  }

  if (callbackFailed) {
    throw callbackError;
  }

  return callbackResult;
}
