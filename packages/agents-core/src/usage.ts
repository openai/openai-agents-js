import { RequestUsageData, UsageData } from './types/protocol';

type RequestUsageInput = Partial<
  RequestUsageData & {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details: object;
    output_tokens_details: object;
    endpoint?: string;
  }
>;

type UsageInput = Partial<
  UsageData & {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details:
      | Record<string, number>
      | Array<Record<string, number>>
      | object;
    output_tokens_details:
      | Record<string, number>
      | Array<Record<string, number>>
      | object;
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
  public inputTokensDetails: Record<string, number>;

  /**
   * Details about the output tokens used for this request.
   */
  public outputTokensDetails: Record<string, number>;

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
      ? (inputTokensDetails as Record<string, number>)
      : {};
    const outputTokensDetails =
      input?.outputTokensDetails ?? input?.output_tokens_details;
    this.outputTokensDetails = outputTokensDetails
      ? (outputTokensDetails as Record<string, number>)
      : {};
    if (typeof input?.endpoint !== 'undefined') {
      this.endpoint = input.endpoint;
    }
  }
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
  public inputTokensDetails: Array<Record<string, number>> = [];

  /**
   * Details about the output tokens used across all requests.
   */
  public outputTokensDetails: Array<Record<string, number>> = [];

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
        this.inputTokensDetails = inputTokensDetails as Array<
          Record<string, number>
        >;
      } else {
        this.inputTokensDetails = inputTokensDetails
          ? [inputTokensDetails as Record<string, number>]
          : [];
      }
      const outputTokensDetails =
        input?.outputTokensDetails ?? input?.output_tokens_details;
      if (Array.isArray(outputTokensDetails)) {
        this.outputTokensDetails = outputTokensDetails as Array<
          Record<string, number>
        >;
      } else {
        this.outputTokensDetails = outputTokensDetails
          ? [outputTokensDetails as Record<string, number>]
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

  add(newUsage: Usage) {
    this.requests += newUsage.requests ?? 0;
    this.inputTokens += newUsage.inputTokens ?? 0;
    this.outputTokens += newUsage.outputTokens ?? 0;
    this.totalTokens += newUsage.totalTokens ?? 0;
    if (newUsage.inputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.inputTokensDetails.push(...newUsage.inputTokensDetails);
    }
    if (newUsage.outputTokensDetails) {
      // The type does not allow undefined, but it could happen runtime
      this.outputTokensDetails.push(...newUsage.outputTokensDetails);
    }

    if (
      Array.isArray(newUsage.requestUsageEntries) &&
      newUsage.requestUsageEntries.length > 0
    ) {
      this.requestUsageEntries ??= [];
      this.requestUsageEntries.push(
        ...newUsage.requestUsageEntries.map((entry) =>
          entry instanceof RequestUsage ? entry : new RequestUsage(entry),
        ),
      );
    } else if (newUsage.requests === 1 && newUsage.totalTokens > 0) {
      this.requestUsageEntries ??= [];
      this.requestUsageEntries.push(
        new RequestUsage({
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
