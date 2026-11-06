export type { JsonObject as NativeConfig } from './binding';

/** @internal Required discovery policy for native persistent sessions. */
export const persistentSessionConfig = {
  'features.apps': false,
  'features.plugins': false,
  'features.tool_registry.error_on_tool_collisions': true,
} as const;
