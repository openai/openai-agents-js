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

export function registerOpenAIProvider(provider: { invalidateClient(): void }) {
  _providerRegistry.add(provider);
}

export function unregisterOpenAIProvider(provider: {
  invalidateClient(): void;
}) {
  _providerRegistry.delete(provider);
}

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

export function setDefaultOpenAIClient(client: OpenAI) {
  console.log('Setting default OpenAI client', client.project, client.apiKey);
  _defaultOpenAIClient = client;
}

export function getDefaultOpenAIClient(): OpenAI | undefined {
  console.log(
    'Getting default OpenAI client',
    _defaultOpenAIClient?.project,
    _defaultOpenAIClient?.apiKey,
  );
  return _defaultOpenAIClient;
}

export function setDefaultOpenAIKey(key: string) {
  console.log('setting default OpenAI key', key);
  _defaultOpenAIKey = key;
  notifyProvidersOfKeyChange();
}

export function getDefaultOpenAIKey(): string | undefined {
  console.log('getting default OpenAI key', _defaultOpenAIKey);
  return _defaultOpenAIKey ?? loadEnv().OPENAI_API_KEY;
}

export const HEADERS = {
  'User-Agent': `Agents/JavaScript ${METADATA.version}`,
};
