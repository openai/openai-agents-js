// Use function instead of exporting the value to prevent
// circular dependency resolution issues caused by other exports in '@openai/agents-core/_shims'
import * as _shims from '@openai/agents-core/_shims';

function fallbackIsBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  );
}

function isBrowserEnvironment(): boolean {
  try {
    if (typeof _shims?.isBrowserEnvironment === 'function') {
      return _shims.isBrowserEnvironment();
    }
  } catch {
    // Fallback below.
  }
  return fallbackIsBrowserEnvironment();
}

/**
 * Loads environment variables from the process environment.
 *
 * @returns An object containing the environment variables.
 */
export function loadEnv(): Record<string, string | undefined> {
  try {
    const env = _shims?.loadEnv?.();
    return typeof env === 'object' && env != null ? env : {};
  } catch {
    return {};
  }
}

/**
 * Checks if a flag is enabled in the environment.
 *
 * @param flagName - The name of the flag to check.
 * @returns `true` if the flag is enabled, `false` otherwise.
 */
function isEnabled(flagName: string): boolean {
  const env = loadEnv();
  return (
    typeof env !== 'undefined' &&
    (env[flagName] === 'true' || env[flagName] === '1')
  );
}

/**
 * Global configuration for tracing.
 */
export const tracing = {
  get disabled() {
    if (isBrowserEnvironment()) {
      return true;
    } else if (loadEnv().NODE_ENV === 'test') {
      // disabling by default in tests
      return true;
    }
    return isEnabled('OPENAI_AGENTS_DISABLE_TRACING');
  },
};

/**
 * Global configuration for logging.
 */
export const logging = {
  get dontLogModelData() {
    return isEnabled('OPENAI_AGENTS_DONT_LOG_MODEL_DATA');
  },
  get dontLogToolData() {
    return isEnabled('OPENAI_AGENTS_DONT_LOG_TOOL_DATA');
  },
};
