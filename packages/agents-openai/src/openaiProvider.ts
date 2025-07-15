import { Model, ModelProvider } from '@openai/agents-core';
import OpenAI from 'openai';
import {
  DEFAULT_OPENAI_MODEL,
  getDefaultOpenAIClient,
  getDefaultOpenAIKey,
  shouldUseResponsesByDefault,
  registerOpenAIProvider,
  unregisterOpenAIProvider,
} from './defaults';
import { OpenAIResponsesModel } from './openaiResponsesModel';
import { OpenAIChatCompletionsModel } from './openaiChatCompletionsModel';

/**
 * Options for OpenAIProvider.
 */
export type OpenAIProviderOptions = {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  useResponses?: boolean;
  openAIClient?: OpenAI;
};

/**
 * The provider of OpenAI's models (or Chat Completions compatible ones)
 */
export class OpenAIProvider implements ModelProvider {
  #client?: OpenAI;
  #useResponses?: boolean;
  #options: OpenAIProviderOptions;
  #shouldRegisterForKeyChanges: boolean;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#options = options;
    if (this.#options.openAIClient) {
      if (this.#options.apiKey) {
        throw new Error('Cannot provide both apiKey and openAIClient');
      }
      if (this.#options.baseURL) {
        throw new Error('Cannot provide both baseURL and openAIClient');
      }
      this.#client = this.#options.openAIClient;
      this.#shouldRegisterForKeyChanges = false;
    } else {
      // Only register for key changes if we don't have a pre-built client
      // and don't have a specific API key (using default key)
      this.#shouldRegisterForKeyChanges = !this.#options.apiKey;
      if (this.#shouldRegisterForKeyChanges) {
        registerOpenAIProvider(this);
      }
    }
    this.#useResponses = this.#options.useResponses;
  }

  /**
   * Invalidates the cached client. Called when the default API key changes.
   */
  invalidateClient(): void {
    this.#client = undefined;
  }

  /**
   * Cleanup method to unregister from key change notifications.
   * Should be called when the provider is no longer needed to prevent memory leaks.
   * Only providers that use the default API key need to call this method.
   */
  destroy(): void {
    if (this.#shouldRegisterForKeyChanges) {
      unregisterOpenAIProvider(this);
    }
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
    // LEFT ON PURPOSE: will delete when merged
    console.log(
      'Using OpenAI client',
      this.#client.project,
      this.#client.apiKey,
    );
    // Return
    return this.#client;
  }

  async getModel(modelName?: string | undefined): Promise<Model> {
    const model = modelName || DEFAULT_OPENAI_MODEL;
    const useResponses = this.#useResponses ?? shouldUseResponsesByDefault();

    if (useResponses) {
      return new OpenAIResponsesModel(this.#getClient(), model);
    }

    return new OpenAIChatCompletionsModel(this.#getClient(), model);
  }
}
