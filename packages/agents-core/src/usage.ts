import { UsageData } from './types/protocol';

type UsageInput = Partial<
  UsageData & {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details: object;
    output_tokens_details: object;
  }
> & { requests?: number };

/**
 * Tracks token usage and request counts for an agent run.
 */
export class Usage {
  /**
   * The number of requests made to the LLM API.
   */
  public requests: number;

  /**
   * The number of input tokens used across all requests.
   */
  public inputTokens: number;

  /**
   * The number of output tokens used across all requests.
   */
  public outputTokens: number;

  /**
   * The total number of tokens sent and received, across all requests.
   */
  public totalTokens: number;

  /**
   * Details about the input tokens used across all requests.
   */
  public inputTokensDetails: Array<Record<string, number>> = [];

  /**
   * Details about the output tokens used across all requests.
   */
  public outputTokensDetails: Array<Record<string, number>> = [];

  constructor(input?: UsageInput) {
    if (typeof input === 'undefined') {
      this.requests = 0;
      this.inputTokens = 0;
      this.outputTokens = 0;
      this.totalTokens = 0;
      this.inputTokensDetails = [];
      this.outputTokensDetails = [];
    } else {
      this.requests = input?.requests ?? 1;
      this.inputTokens = input?.inputTokens ?? input?.input_tokens ?? 0;
      this.outputTokens = input?.outputTokens ?? input?.output_tokens ?? 0;
      this.totalTokens = input?.totalTokens ?? input?.total_tokens ?? 0;
      const inputTokensDetails =
        input?.inputTokensDetails ?? input?.input_tokens_details;
      this.inputTokensDetails = inputTokensDetails
        ? [inputTokensDetails as Record<string, number>]
        : [];
      const outputTokensDetails =
        input?.outputTokensDetails ?? input?.output_tokens_details;
      this.outputTokensDetails = outputTokensDetails
        ? [outputTokensDetails as Record<string, number>]
        : [];
    }
  }

  add(newUsage: Usage) {
    this.requests += newUsage.requests;
    this.inputTokens += newUsage.inputTokens;
    this.outputTokens += newUsage.outputTokens;
    this.totalTokens += newUsage.totalTokens;
    if (newUsage.inputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.inputTokensDetails.push(...newUsage.inputTokensDetails);
    }
    if (newUsage.outputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.outputTokensDetails.push(...newUsage.outputTokensDetails);
    }
  }
}

export { UsageData };
