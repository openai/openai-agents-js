export type HostedMultiAgentConfig = Readonly<{
  /**
   * Maximum number of hosted subagents that may be active at once.
   * Omit this value to use the service default.
   */
  maxConcurrentSubagents?: number;
}>;
