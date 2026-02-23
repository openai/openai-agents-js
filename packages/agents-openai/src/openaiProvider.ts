import { Model, ModelProvider, getDefaultModel } from '@openai/agents-core';
import OpenAI from 'openai';
import {
  getDefaultOpenAIClient,
  getDefaultOpenAIKey,
  getDefaultOpenAIWebSocketBaseURL,
  shouldUseResponsesByDefault,
  shouldUseResponsesWebSocketByDefault,
} from './defaults';
import {
  OpenAIResponsesModel,
  OpenAIResponsesWSModel,
} from './openaiResponsesModel';
import { OpenAIChatCompletionsModel } from './openaiChatCompletionsModel';

/**
 * Options for OpenAIProvider.
 */
export type OpenAIProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  websocketBaseURL?: string;
  cacheResponsesWebSocketModels?: boolean;
  organization?: string;
  project?: string;
  useResponses?: boolean;
  useResponsesWebSocket?: boolean;
  openAIClient?: OpenAI;
};

/**
 * The provider of OpenAI's models (or Chat Completions compatible ones)
 */
export class OpenAIProvider implements ModelProvider {
  #client?: OpenAI;
  #useResponses?: boolean;
  #useResponsesWebSocket?: boolean;
  #websocketBaseURL?: string;
  #cacheResponsesWebSocketModels: boolean;
  #modelCache = new Map<string, Model>();
  #options: OpenAIProviderOptions;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#options = options;
    if (this.#options.openAIClient) {
      if (this.#options.apiKey) {
        throw new Error('Cannot provide both apiKey and openAIClient');
      }
      if (this.#options.baseURL) {
        throw new Error('Cannot provide both baseURL and openAIClient');
      }
      if (this.#options.websocketBaseURL) {
        throw new Error(
          'Cannot provide both websocketBaseURL and openAIClient',
        );
      }
      this.#client = this.#options.openAIClient;
    }
    this.#useResponses = this.#options.useResponses;
    this.#useResponsesWebSocket = this.#options.useResponsesWebSocket;
    this.#websocketBaseURL = this.#options.websocketBaseURL;
    this.#cacheResponsesWebSocketModels =
      this.#options.cacheResponsesWebSocketModels ?? true;
  }

  /**
   * Lazy loads the OpenAI client to not throw an error if you don't have an API key set but
   * never actually use the client.
   */
  #getClient(): OpenAI {
    // If the constructor does not accept the OpenAI client,
    if (!this.#client) {
      this.#client =
        // this provider checks if there is the default client first,
        getDefaultOpenAIClient() ??
        // and then manually creates a new one.
        new OpenAI({
          apiKey: this.#options.apiKey ?? getDefaultOpenAIKey(),
          baseURL: this.#options.baseURL,
          organization: this.#options.organization,
          project: this.#options.project,
        });
    }
    return this.#client;
  }

  #getWebSocketBaseURLForResponsesModel(client: OpenAI): string | undefined {
    if (typeof this.#websocketBaseURL !== 'undefined') {
      return this.#websocketBaseURL;
    }

    // Preserve configured client/provider endpoints rather than redirecting via env websocket base URL.
    if (this.#options.openAIClient || this.#options.baseURL) {
      return undefined;
    }

    const defaultClient = getDefaultOpenAIClient();
    if (defaultClient && client === defaultClient) {
      return undefined;
    }

    return getDefaultOpenAIWebSocketBaseURL();
  }

  async getModel(modelName?: string | undefined): Promise<Model> {
    const model = modelName || getDefaultModel();
    const useResponses = this.#useResponses ?? shouldUseResponsesByDefault();
    const useResponsesWebSocket =
      this.#useResponsesWebSocket ?? shouldUseResponsesWebSocketByDefault();
    const shouldCacheModelWrapper = !(
      useResponses &&
      useResponsesWebSocket &&
      !this.#cacheResponsesWebSocketModels
    );
    const cacheKey = JSON.stringify([
      model,
      useResponses,
      useResponsesWebSocket,
    ]);

    if (shouldCacheModelWrapper) {
      const cachedModel = this.#modelCache.get(cacheKey);
      if (cachedModel) {
        return cachedModel;
      }
    }

    let resolvedModel: Model;

    if (useResponses) {
      const client = this.#getClient();
      resolvedModel = useResponsesWebSocket
        ? new OpenAIResponsesWSModel(client, model, {
            websocketBaseURL:
              this.#getWebSocketBaseURLForResponsesModel(client),
            reuseConnection: shouldCacheModelWrapper,
          })
        : new OpenAIResponsesModel(client, model);
    } else {
      resolvedModel = new OpenAIChatCompletionsModel(this.#getClient(), model);
    }

    if (shouldCacheModelWrapper) {
      this.#modelCache.set(cacheKey, resolvedModel);
    }
    return resolvedModel;
  }

  /**
   * Closes cached model wrappers (for example websocket-backed responses models) and clears cache.
   */
  async close(): Promise<void> {
    const cachedModels = Array.from(new Set(this.#modelCache.values()));
    this.#modelCache.clear();

    const closeErrors: unknown[] = [];
    await Promise.all(
      cachedModels.map(async (model) => {
        const maybeClose = (model as { close?: () => Promise<void> | void })
          .close;
        if (typeof maybeClose !== 'function') {
          return;
        }
        try {
          await maybeClose.call(model);
        } catch (error) {
          closeErrors.push(error);
        }
      }),
    );

    if (closeErrors.length === 1) {
      throw closeErrors[0];
    }
    if (closeErrors.length > 1) {
      const error = new Error('Failed to close OpenAIProvider.');
      (error as Error & { causes?: unknown[] }).causes = closeErrors;
      throw error;
    }
  }
}
