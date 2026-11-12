import type { captureThreadStore } from './custom-thread-store';
import type { splitToolDeclarations } from './tool-declarations';
import type { ToolCatalog } from './tools';

/** @internal Opening compatibility for captured custom storage declarations. */
export function validateCustomStorageCompatibility(
  customStore: ReturnType<typeof captureThreadStore> | undefined,
  declarations: ReturnType<typeof splitToolDeclarations>,
  catalog: ToolCatalog,
  hasEnvironment: boolean,
): void {
  if (
    customStore &&
    (hasEnvironment ||
      (declarations.webSearch && declarations.webSearch.route !== 'hosted') ||
      declarations.checklist ||
      declarations.nativeGoals ||
      declarations.nativeAgents ||
      catalog.tools.some((tool) => tool.kind === 'manual'))
  )
    throw new TypeError(
      'Custom canonical storage does not support environments, standalone native search, checklists, goals, child agents, or manual tools',
    );
}

/** @internal Compatibility for captured prepareRequest declarations. */
export function validatePrepareRequestCompatibility(
  prepareRequest: unknown,
  outputRepair: boolean,
  websocketsAllowed: boolean,
  hasUnsupportedFeatures: boolean,
): void {
  if (typeof prepareRequest !== 'function')
    throw new TypeError('prepareRequest must be callable');
  if (outputRepair)
    throw new TypeError(
      'prepareRequest does not support output correction attempts; use native output or prompted maxRetries: 0',
    );
  if (websocketsAllowed)
    throw new TypeError(
      'prepareRequest requires NativeProvider({ supportsWebsockets: false })',
    );
  if (hasUnsupportedFeatures)
    throw new TypeError(
      'prepareRequest supports only direct root eager function and ordinary MCP tools',
    );
}
