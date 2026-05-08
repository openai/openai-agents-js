type PromptCacheRetention =
  | 'in-memory'
  | 'in_memory'
  | '24h'
  | null
  | undefined;

export function normalizePromptCacheRetention(
  value: PromptCacheRetention,
): 'in_memory' | '24h' | null | undefined {
  return value === 'in-memory' ? 'in_memory' : value;
}
