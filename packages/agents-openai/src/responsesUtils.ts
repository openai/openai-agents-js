import { RequestUsage } from '@openai/agents-core';
import OpenAI from 'openai';

export function normalizeInstructions(
  instructions: string | undefined,
): string | undefined {
  if (typeof instructions === 'string') {
    return instructions.trim() === '' ? undefined : instructions;
  }
  return undefined;
}

export function searchParamsToAuthHeaderQuery(
  searchParams: URLSearchParams,
): Record<string, string | string[]> | undefined {
  const query: Record<string, string | string[]> = {};
  let hasEntries = false;

  for (const [key, value] of searchParams.entries()) {
    hasEntries = true;
    const existingValue = query[key];
    if (typeof existingValue === 'undefined') {
      query[key] = value;
    } else if (Array.isArray(existingValue)) {
      existingValue.push(value);
    } else {
      query[key] = [existingValue, value];
    }
  }

  return hasEntries ? query : undefined;
}

export function toRequestUsageEntry(
  usage: OpenAI.Responses.ResponseUsage | undefined,
  endpoint: string,
): RequestUsage {
  return new RequestUsage({
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokensDetails: { ...usage?.input_tokens_details },
    outputTokensDetails: { ...usage?.output_tokens_details },
    endpoint,
  });
}
