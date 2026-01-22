import { OpenAI } from 'openai';
import { loadEnv } from '@openai/agents-core/_shims';
import METADATA from './metadata';

export const DEFAULT_OPENAI_API = 'responses';
export const DEFAULT_OPENAI_MODEL = 'gpt-4.1';

let _defaultOpenAIAPI = DEFAULT_OPENAI_API;
let _defaultOpenAIClient: OpenAI | undefined;
let _defaultOpenAIKey: string | undefined = undefined;
let _defaultTracingApiKey: string | undefined = undefined;
let _openAIResponsesFallbackEnabled: boolean | undefined = undefined;

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
  _defaultOpenAIClient = client;
}

export function getDefaultOpenAIClient(): OpenAI | undefined {
  return _defaultOpenAIClient;
}

export function setDefaultOpenAIKey(key: string) {
  _defaultOpenAIKey = key;
}

export function getDefaultOpenAIKey(): string | undefined {
  return _defaultOpenAIKey ?? loadEnv().OPENAI_API_KEY;
}

export function setOpenAIResponsesFallbackEnabled(enabled: boolean) {
  _openAIResponsesFallbackEnabled = enabled;
}

export function isOpenAIResponsesFallbackEnabled(): boolean {
  if (typeof _openAIResponsesFallbackEnabled === 'boolean') {
    return _openAIResponsesFallbackEnabled;
  }
  const env = loadEnv();
  const flag = env.OPENAI_RESPONSES_FALLBACK;
  return flag === 'true' || flag === '1';
}

export const HEADERS = {
  'User-Agent': `Agents/JavaScript ${METADATA.version}`,
};
