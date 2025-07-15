import { OpenAI } from 'openai';
import { loadEnv } from '@openai/agents-core/_shims';
import METADATA from './metadata';

export const DEFAULT_OPENAI_API = 'responses';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

let _defaultOpenAIAPI = DEFAULT_OPENAI_API;
let _defaultOpenAIClient: OpenAI | undefined;
let _defaultOpenAIKey: string | undefined = undefined;
let _defaultTracingApiKey: string | undefined = undefined;

// Registry for tracking OpenAI providers that need to be notified of key changes
const _providerRegistry = new Set<{ invalidateClient(): void }>();

/**
 * Registers an OpenAI provider to receive notifications when the default API key or client changes.
 * @param provider The provider to register for key change notifications
 */
export function registerOpenAIProvider(provider: { invalidateClient(): void }) {
  _providerRegistry.add(provider);
}

/**
 * Unregisters an OpenAI provider from key change notifications.
 * @param provider The provider to unregister
 */
export function unregisterOpenAIProvider(provider: {
  invalidateClient(): void;
}) {
  _providerRegistry.delete(provider);
}

/**
 * Notifies all registered providers that the default API key or client has changed.
 * This causes providers to invalidate their cached clients.
 */
function notifyProvidersOfKeyChange() {
  _providerRegistry.forEach((provider) => {
    try {
      provider.invalidateClient();
    } catch (error) {
      // Ignore errors in provider invalidation to prevent breaking the system
      console.warn('Error invalidating provider client:', error);
    }
  });
}

export function setTracingExportApiKey(key: string) {
  _defaultTracingApiKey = key;
}

export function getTracingExportApiKey(): string | undefined {
  return _defaultTracingApiKey ?? loadEnv().OPENAI_API_KEY;
}

export function shouldUseResponsesByDefault() {
  return _defaultOpenAIAPI === 'responses';
}

export function setOpenAIAPI(value: 'chat_completions' | 'responses') {
  _defaultOpenAIAPI = value;
}

/**
 * Sets the default OpenAI client to use for all providers.
 * This will invalidate cached clients in existing providers that rely on the default client.
 * @param client The OpenAI client to use as the default
 */
export function setDefaultOpenAIClient(client: OpenAI) {
  _defaultOpenAIClient = client;
  notifyProvidersOfKeyChange();
}

export function getDefaultOpenAIClient(): OpenAI | undefined {
  return _defaultOpenAIClient;
}

/**
 * Sets the default OpenAI API key to use for all providers.
 * This will invalidate cached clients in existing providers that rely on the default key.
 * @param key The OpenAI API key to use as the default
 */
export function setDefaultOpenAIKey(key: string) {
  _defaultOpenAIKey = key;
  notifyProvidersOfKeyChange();
}

export function getDefaultOpenAIKey(): string | undefined {
  return _defaultOpenAIKey ?? loadEnv().OPENAI_API_KEY;
}

export const HEADERS = {
  'User-Agent': `Agents/JavaScript ${METADATA.version}`,
};
