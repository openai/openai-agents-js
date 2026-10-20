import { RequestUsageData, UsageData, TokenDetails } from './types/protocol';

export type RequestUsageInput = Partial<
  RequestUsageData & {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details: object;
    output_tokens_details: object;
    endpoint?: string;
  }
>;

export type UsageInput = Partial<
  UsageData & {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details: TokenDetails | Array<TokenDetails> | object;
    output_tokens_details: TokenDetails | Array<TokenDetails> | object;
    request_usage_entries: RequestUsageInput[];
  }
> & { requests?: number; requestUsageEntries?: RequestUsageInput[] };

/**
 * Usage details for a single API request.
 */
export class RequestUsage {
  /**
   * The number of input tokens used for this request.
   */
  public inputTokens: number;

  /**
   * The number of output tokens used for this request.
   */
  public outputTokens: number;

  /**
   * The total number of tokens sent and received for this request.
   */
  public totalTokens: number;

  /**
   * Details about the input tokens used for this request.
   */
  public inputTokensDetails: TokenDetails;

  /**
   * Details about the output tokens used for this request.
   */
  public outputTokensDetails: TokenDetails;

  /**
   * The endpoint that produced this usage entry (e.g., responses.create, responses.compact).
   */
  public endpoint?: 'responses.create' | 'responses.compact' | (string & {});

  constructor(input?: RequestUsageInput) {
    this.inputTokens = input?.inputTokens ?? input?.input_tokens ?? 0;
    this.outputTokens = input?.outputTokens ?? input?.output_tokens ?? 0;
    this.totalTokens =
      input?.totalTokens ??
      input?.total_tokens ??
      this.inputTokens + this.outputTokens;
    const inputTokensDetails =
      input?.inputTokensDetails ?? input?.input_tokens_details;
    this.inputTokensDetails = inputTokensDetails
      ? (inputTokensDetails as TokenDetails)
      : {};
    const outputTokensDetails =
      input?.outputTokensDetails ?? input?.output_tokens_details;
    this.outputTokensDetails = outputTokensDetails
      ? (outputTokensDetails as TokenDetails)
      : {};
    if (typeof input?.endpoint !== 'undefined') {
      this.endpoint = input.endpoint;
    }
  }

  /**
   * Reconstructs a RequestUsage instance from a JSON-compatible wire value.
   */
  static fromJSON(input?: RequestUsageInput): RequestUsage {
    return new RequestUsage(input);
  }
}

export function cloneTokenDetails(details: TokenDetails): TokenDetails {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'number' ? value : cloneTokenDetails(value),
    ]),
  );
}

function cloneRequestUsage(input: RequestUsageInput): RequestUsage {
  const cloned = new RequestUsage(input);
  cloned.inputTokensDetails = cloneTokenDetails(cloned.inputTokensDetails);
  cloned.outputTokensDetails = cloneTokenDetails(cloned.outputTokensDetails);
  return cloned;
}

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
  public inputTokensDetails: Array<TokenDetails> = [];

  /**
   * Details about the output tokens used across all requests.
   */
  public outputTokensDetails: Array<TokenDetails> = [];

  /**
   * List of per-request usage entries for detailed cost calculations.
   */
  public requestUsageEntries: RequestUsage[] | undefined;

  constructor(input?: UsageInput) {
    if (typeof input === 'undefined') {
      this.requests = 0;
      this.inputTokens = 0;
      this.outputTokens = 0;
      this.totalTokens = 0;
      this.inputTokensDetails = [];
      this.outputTokensDetails = [];
      this.requestUsageEntries = undefined;
    } else {
      this.requests = input?.requests ?? 1;
      this.inputTokens = input?.inputTokens ?? input?.input_tokens ?? 0;
      this.outputTokens = input?.outputTokens ?? input?.output_tokens ?? 0;
      this.totalTokens =
        input?.totalTokens ??
        input?.total_tokens ??
        this.inputTokens + this.outputTokens;
      const inputTokensDetails =
        input?.inputTokensDetails ?? input?.input_tokens_details;
      if (Array.isArray(inputTokensDetails)) {
        this.inputTokensDetails = inputTokensDetails as Array<TokenDetails>;
      } else {
        this.inputTokensDetails = inputTokensDetails
          ? [inputTokensDetails as TokenDetails]
          : [];
      }
      const outputTokensDetails =
        input?.outputTokensDetails ?? input?.output_tokens_details;
      if (Array.isArray(outputTokensDetails)) {
        this.outputTokensDetails = outputTokensDetails as Array<TokenDetails>;
      } else {
        this.outputTokensDetails = outputTokensDetails
          ? [outputTokensDetails as TokenDetails]
          : [];
      }

      const requestUsageEntries =
        input?.requestUsageEntries ?? input?.request_usage_entries;
      const normalizedRequestUsageEntries = Array.isArray(requestUsageEntries)
        ? requestUsageEntries.map((entry) =>
            entry instanceof RequestUsage ? entry : new RequestUsage(entry),
          )
        : undefined;
      this.requestUsageEntries =
        normalizedRequestUsageEntries &&
        normalizedRequestUsageEntries.length > 0
          ? normalizedRequestUsageEntries
          : undefined;
    }
  }

  /**
   * Reconstructs a Usage instance from a JSON-compatible wire value.
   */
  static fromJSON(input?: UsageInput): Usage {
    return new Usage(input);
  }

  add(newUsage: Usage) {
    this.requests += newUsage.requests ?? 0;
    this.inputTokens += newUsage.inputTokens ?? 0;
    this.outputTokens += newUsage.outputTokens ?? 0;
    this.totalTokens += newUsage.totalTokens ?? 0;
    if (newUsage.inputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.inputTokensDetails.push(
        ...newUsage.inputTokensDetails.map(cloneTokenDetails),
      );
    }
    if (newUsage.outputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.outputTokensDetails.push(
        ...newUsage.outputTokensDetails.map(cloneTokenDetails),
      );
    }

    if (
      Array.isArray(newUsage.requestUsageEntries) &&
      newUsage.requestUsageEntries.length > 0
    ) {
      this.requestUsageEntries ??= [];
      this.requestUsageEntries.push(
        ...newUsage.requestUsageEntries.map(cloneRequestUsage),
      );
    } else if (newUsage.requests === 1 && newUsage.totalTokens > 0) {
      this.requestUsageEntries ??= [];
      this.requestUsageEntries.push(
        cloneRequestUsage({
          inputTokens: newUsage.inputTokens,
          outputTokens: newUsage.outputTokens,
          totalTokens: newUsage.totalTokens,
          inputTokensDetails: newUsage.inputTokensDetails?.[0],
          outputTokensDetails: newUsage.outputTokensDetails?.[0],
        }),
      );
    }
  }
}

export { RequestUsageData, UsageData };
