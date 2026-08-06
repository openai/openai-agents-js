export type TracingConfig = {
  apiKey?: string;
  /**
   * Whether runner-created task and turn spans are included in traces.
   *
   * Defaults to `true`. Set to `false` to keep the existing agent, model,
   * tool, guardrail, and handoff spans without the additional task/turn
   * hierarchy.
   */
  includeTaskAndTurnSpans?: boolean;
};

export function includeTaskAndTurnSpans(
  config: TracingConfig | undefined,
): boolean {
  return config?.includeTaskAndTurnSpans ?? true;
}

export function mergeTracingConfig(
  ...configs: (TracingConfig | undefined)[]
): TracingConfig | undefined {
  if (configs.every((config) => config === undefined)) {
    return undefined;
  }

  const merged: Record<string, unknown> = {};
  for (const config of configs) {
    for (const [key, value] of Object.entries(config ?? {})) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
  }
  return merged as TracingConfig;
}
