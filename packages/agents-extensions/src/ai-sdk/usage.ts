import type { GenerationUsageData } from '@openai/agents';

function extractTokenCount(usage: any, key: string): number {
  const value = usage?.[key];
  if (typeof value === 'number') {
    return Number.isNaN(value) ? 0 : value;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof value.total === 'number'
  ) {
    return value.total;
  }
  return 0;
}

function toUsageDetailTokenCount(value: unknown): number | undefined {
  if (typeof value !== 'number') {
    return undefined;
  }
  return Number.isNaN(value) ? 0 : value;
}

function extractInputTokenDetails(
  usage: any,
): Record<string, number> | undefined {
  const inputTokens = usage?.inputTokens;
  if (typeof inputTokens !== 'object' || inputTokens === null) {
    return undefined;
  }

  const cachedTokens = toUsageDetailTokenCount((inputTokens as any).cacheRead);
  const cacheWriteTokens = toUsageDetailTokenCount(
    (inputTokens as any).cacheWrite,
  );

  if (
    typeof cachedTokens !== 'number' &&
    typeof cacheWriteTokens !== 'number'
  ) {
    return undefined;
  }

  return {
    ...(typeof cachedTokens === 'number'
      ? { cached_tokens: cachedTokens }
      : {}),
    ...(typeof cacheWriteTokens === 'number'
      ? { cache_write_tokens: cacheWriteTokens }
      : {}),
  };
}

function extractOutputTokenDetails(
  usage: any,
): Record<string, number> | undefined {
  const outputTokens = usage?.outputTokens;
  if (typeof outputTokens !== 'object' || outputTokens === null) {
    return undefined;
  }

  const reasoningTokens = toUsageDetailTokenCount(
    (outputTokens as any).reasoning,
  );
  const textTokens = toUsageDetailTokenCount((outputTokens as any).text);

  if (typeof reasoningTokens !== 'number' && typeof textTokens !== 'number') {
    return undefined;
  }

  return {
    ...(typeof reasoningTokens === 'number'
      ? { reasoning_tokens: reasoningTokens }
      : {}),
    ...(typeof textTokens === 'number' ? { text_tokens: textTokens } : {}),
  };
}

export function extractUsage(usage: any): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputTokensDetails?: Record<string, number>;
  outputTokensDetails?: Record<string, number>;
} {
  const inputTokens = extractTokenCount(usage, 'inputTokens');
  const outputTokens = extractTokenCount(usage, 'outputTokens');
  const inputTokensDetails = extractInputTokenDetails(usage);
  const outputTokensDetails = extractOutputTokenDetails(usage);

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(inputTokensDetails ? { inputTokensDetails } : {}),
    ...(outputTokensDetails ? { outputTokensDetails } : {}),
  };
}

export function toTracingUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  inputTokensDetails?: Record<string, number>;
  outputTokensDetails?: Record<string, number>;
}): GenerationUsageData {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.inputTokensDetails
      ? { input_tokens_details: usage.inputTokensDetails }
      : {}),
    ...(usage.outputTokensDetails
      ? { output_tokens_details: usage.outputTokensDetails }
      : {}),
  };
}
