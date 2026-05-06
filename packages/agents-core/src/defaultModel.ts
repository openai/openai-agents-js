import { loadEnv } from './config';
import { ModelSettings, ModelSettingsReasoningEffort } from './model';

export const OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME = 'OPENAI_DEFAULT_MODEL';
const GPT_5_CHAT_MODEL_PATTERNS = [
  /^gpt-5-chat-latest$/,
  /^gpt-5\.1-chat-latest$/,
  /^gpt-5\.2-chat-latest$/,
  /^gpt-5\.3-chat-latest$/,
] as const;

/**
 * Returns True if the model name is a GPT-5 model and reasoning settings are required.
 */
export function gpt5ReasoningSettingsRequired(modelName: string): boolean {
  if (GPT_5_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(modelName))) {
    // Chat-latest aliases do not accept reasoning.effort.
    return false;
  }
  // matches any of gpt-5 models
  return modelName.startsWith('gpt-5');
}

const DEFAULT_REASONING_EFFORT_PATTERNS: Array<
  readonly [
    RegExp,
    Exclude<ModelSettingsReasoningEffort, 'minimal' | 'xhigh' | null>,
  ]
> = [
  [/^gpt-5(?:-\d{4}-\d{2}-\d{2})?$/, 'low'],
  [/^gpt-5\.1(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
  [/^gpt-5\.2(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
  [/^gpt-5\.2-pro(?:-\d{4}-\d{2}-\d{2})?$/, 'medium'],
  [/^gpt-5\.2-codex$/, 'low'],
  [/^gpt-5\.3-codex$/, 'none'],
  [/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
  [/^gpt-5\.4-pro(?:-\d{4}-\d{2}-\d{2})?$/, 'medium'],
  [/^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
  [/^gpt-5\.4-nano(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
  [/^gpt-5\.5(?:-\d{4}-\d{2}-\d{2})?$/, 'none'],
];

function getDefaultReasoningEffort(
  modelName: string,
):
  | Exclude<ModelSettingsReasoningEffort, 'minimal' | 'xhigh' | null>
  | undefined {
  for (const [pattern, effort] of DEFAULT_REASONING_EFFORT_PATTERNS) {
    if (pattern.test(modelName)) {
      return effort;
    }
  }
  return undefined;
}

/**
 * Returns True if the default model is a GPT-5 model.
 * This is used to determine if the default model settings are compatible with GPT-5 models.
 * If the default model is not a GPT-5 model, the model settings are compatible with other models.
 */
export function isGpt5Default(): boolean {
  return gpt5ReasoningSettingsRequired(getDefaultModel());
}

/**
 * Returns the default model name.
 */
export function getDefaultModel(): string {
  const env = loadEnv();
  return (
    env[OPENAI_DEFAULT_MODEL_ENV_VARIABLE_NAME]?.toLowerCase() ?? 'gpt-5.4-mini'
  );
}

/**
 * Returns the default model settings.
 * If the default model is a GPT-5 model, returns the GPT-5 default model settings.
 * Otherwise, returns the legacy default model settings.
 */
export function getDefaultModelSettings(model?: string): ModelSettings {
  const _model = model ?? getDefaultModel();
  if (gpt5ReasoningSettingsRequired(_model)) {
    const effort = getDefaultReasoningEffort(_model);
    if (effort !== undefined) {
      return {
        reasoning: { effort },
        text: { verbosity: 'low' },
      };
    }
    return {
      // Keep the GPT-5 text verbosity default, but omit reasoning.effort for
      // variants whose supported values are not confirmed yet.
      text: { verbosity: 'low' },
    };
  }
  return {};
}
