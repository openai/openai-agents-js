import * as process from 'node:process';

declare global {
  interface ImportMeta {
    env?: Record<string, string | undefined>;
  }
}

export function loadEnv(): Record<string, string | undefined> {
  if (typeof process === 'undefined' || typeof process.env === 'undefined') {
    // In CommonJS builds, import.meta is not available, so we return empty object.
    try {
      // Use eval to avoid TypeScript compilation errors in CommonJS builds.
      const importMeta = (0, eval)('import.meta');
      if (
        typeof importMeta === 'object' &&
        typeof importMeta.env === 'object'
      ) {
        return importMeta.env as unknown as Record<string, string | undefined>;
      }
    } catch {
      // import.meta is not available.
    }
    return {};
  }
  return process.env;
}

export function isBrowserEnvironment(): boolean {
  return false;
}
