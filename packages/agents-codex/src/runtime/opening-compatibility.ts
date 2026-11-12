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
