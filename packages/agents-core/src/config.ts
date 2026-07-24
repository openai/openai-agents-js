import * as _configShims from '@openai/agents-core/_shims/config';

function fallbackIsBrowserEnvironment(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function'
  );
}

function isBrowserEnvironment(): boolean {
  try {
    if (typeof _configShims?.isBrowserEnvironment === 'function') {
      return _configShims.isBrowserEnvironment();
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
    const env = _configShims?.loadEnv?.();
    return typeof env === 'object' && env != null ? env : {};
  } catch {
    return {};
  }
}

/**
 * Checks if a flag is enabled in the environment.
 *
 * @param flagName - The name of the flag to check.
 * @param defaultValue - The value to return when the flag is not set.
 * @returns `true` if the flag is enabled, `false` otherwise.
 */
function isEnabled(flagName: string, defaultValue: boolean = false): boolean {
  const flagValue = loadEnv()[flagName];
  if (flagValue === undefined) {
    return defaultValue;
  }
  if (flagValue === 'true' || flagValue === '1') {
    return true;
  }
  if (flagValue === 'false' || flagValue === '0') {
    return false;
  }
  return defaultValue;
}

let sensitiveDataLoggingEnabledOverride: boolean | undefined;

/**
 * Enables or disables sensitive model and tool data logging programmatically.
 * This override takes precedence over the logging environment variables.
 *
 * @param enabled - Whether sensitive model and tool data may be logged.
 */
export function setSensitiveDataLoggingEnabled(enabled: boolean): void {
  sensitiveDataLoggingEnabledOverride = enabled;
}

function shouldSuppressSensitiveData(flagName: string): boolean {
  if (sensitiveDataLoggingEnabledOverride !== undefined) {
    return !sensitiveDataLoggingEnabledOverride;
  }
  return isEnabled(flagName, true);
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
    return shouldSuppressSensitiveData('OPENAI_AGENTS_DONT_LOG_MODEL_DATA');
  },
  get dontLogToolData() {
    return shouldSuppressSensitiveData('OPENAI_AGENTS_DONT_LOG_TOOL_DATA');
  },
};
