import {
  JsonObjectSchema,
  ModelSettingsToolChoice,
  Prompt,
} from '@openai/agents-core/types';

export type RealtimeClientMessage = {
  type: string;
  [key: string]: any;
};

export type RealtimeUserInput =
  | string
  | {
      type: 'message';
      role: 'user';
      content: (
        | {
            type: 'input_text';
            text: string;
          }
        | {
            type: 'input_image';
            image: string;
            providerData?: Record<string, any>;
          }
      )[];
    };

export type RealtimeAudioFormatDefinition =
  | { type: 'audio/pcm'; rate: number }
  | { type: 'audio/pcmu' }
  | { type: 'audio/pcma' };

// Legacy format (deprecated): string shorthands
// - 'pcm16' (equivalent to { type: 'audio/pcm', rate: 24000 })
// - 'g711_ulaw' (equivalent to { type: 'audio/pcmu' })
// - 'g711_alaw' (equivalent to { type: 'audio/pcma' })
/**
 * @deprecated Use a {type: "audio/pcm"} format instead. String shorthands are deprecated.
 */
export type RealtimeAudioFormatLegacy =
  | 'pcm16'
  | 'g711_ulaw'
  | 'g711_alaw'
  | (string & {});

// User-facing union (legacy accepted, GA preferred)
export type RealtimeAudioFormat =
  | RealtimeAudioFormatLegacy
  | RealtimeAudioFormatDefinition;

export type RealtimeTracingConfig =
  | {
      workflow_name?: string;
      group_id?: string;
      metadata?: Record<string, any>;
    }
  | 'auto';

export type RealtimeInputAudioNoiseReductionConfig = {
  type: 'near_field' | 'far_field' | (string & {});
};

export type RealtimeInputAudioTranscriptionConfig = {
  language?: string;
  model?:
    | 'gpt-4o-transcribe'
    | 'gpt-4o-mini-transcribe'
    | 'whisper-1'
    | (string & {});
  prompt?: string;
};

export type RealtimeTurnDetectionConfigAsIs = {
  type?: 'semantic_vad' | 'server_vad' | (string & {});
  create_response?: boolean;
  eagerness?: 'auto' | 'low' | 'medium' | 'high';
  interrupt_response?: boolean;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  threshold?: number;
  idle_timeout_ms?: number;
};

// The Realtime API accepts snake_cased keys, so when using this, this SDK converts the keys to snake_case ones before passing it to the API.
export type RealtimeTurnDetectionConfigCamelCase = {
  type?: 'semantic_vad' | 'server_vad' | (string & {});
  createResponse?: boolean;
  eagerness?: 'auto' | 'low' | 'medium' | 'high';
  interruptResponse?: boolean;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  threshold?: number;
  idleTimeoutMs?: number;
};

export type RealtimeTurnDetectionConfig = (
  | RealtimeTurnDetectionConfigAsIs
  | RealtimeTurnDetectionConfigCamelCase
) &
  Record<string, any>;

export type RealtimeAudioInputConfig = {
  format?: RealtimeAudioFormat;
  noiseReduction?: RealtimeInputAudioNoiseReductionConfig | null;
  transcription?: RealtimeInputAudioTranscriptionConfig | null;
  turnDetection?: RealtimeTurnDetectionConfig | null;
};

export type RealtimeAudioOutputConfig = {
  format?: RealtimeAudioFormat;
  voice?: string;
  speed?: number;
};

export type RealtimeAudioConfig = {
  input?: RealtimeAudioInputConfig;
  output?: RealtimeAudioOutputConfig;
};

// Shared/common fields across both config shapes
export type RealtimeSessionConfigCommon = {
  model: string;
  instructions: string;
  toolChoice: ModelSettingsToolChoice;
  tools: RealtimeToolDefinition[];
  tracing?: RealtimeTracingConfig | null;
  providerData?: Record<string, any>;
  prompt?: Prompt;
};

export type RealtimeSessionConfigDefinition = RealtimeSessionConfigCommon & {
  outputModalities?: ('text' | 'audio')[];
  audio?: RealtimeAudioConfig;
  /**
   * TODO: We'll eventually migrate to audio.output.voice instead of this property.
   * Until we fully migrate to audio.output.voice for all session implementations,
   * using this top-level voice property helps with backwards compatibility.
   */
  voice?: string;
};

// Deprecated config (legacy) — cannot be mixed with new fields
export type RealtimeSessionConfigDeprecated = RealtimeSessionConfigCommon & {
  /** @deprecated Use outputModalities instead. */
  modalities: ('text' | 'audio')[];
  /** @deprecated Use audio.output.voice instead. */
  voice: string;
  /** @deprecated Use audio.input.format instead. */
  inputAudioFormat: RealtimeAudioFormatLegacy;
  /** @deprecated Use audio.output.format instead. */
  outputAudioFormat: RealtimeAudioFormatLegacy;
  /** @deprecated Use audio.input.transcription instead. */
  inputAudioTranscription: RealtimeInputAudioTranscriptionConfig;
  /** @deprecated Use audio.input.turnDetection instead. */
  turnDetection: RealtimeTurnDetectionConfig;
  /** @deprecated Use audio.input.noiseReduction instead. */
  inputAudioNoiseReduction: RealtimeInputAudioNoiseReductionConfig | null;
  /** @deprecated Use audio.output.speed instead. */
  speed: number;
};

// Union of configs; users should not mix-and-match; runtime converter will normalize
export type RealtimeSessionConfig =
  | RealtimeSessionConfigDefinition
  | RealtimeSessionConfigDeprecated;

function isDefined(
  key:
    | keyof RealtimeSessionConfigDefinition
    | keyof RealtimeSessionConfigDeprecated,
  object: Partial<RealtimeSessionConfig>,
) {
  // @ts-expect-error fudging with types here for the index types
  return key in object && typeof object[key] !== 'undefined';
}

function isDeprecatedConfig(
  config: Partial<RealtimeSessionConfig>,
): config is Partial<RealtimeSessionConfigDeprecated> {
  return (
    isDefined('modalities', config) ||
    isDefined('inputAudioFormat', config) ||
    isDefined('outputAudioFormat', config) ||
    isDefined('inputAudioTranscription', config) ||
    isDefined('turnDetection', config) ||
    isDefined('inputAudioNoiseReduction', config) ||
    isDefined('speed', config)
  );
}

/**
 * Convert any given config (old or new) to the new GA config shape.
 * If a new config is provided, it will be returned as-is (normalized shallowly).
 */
export function toNewSessionConfig(
  config: Partial<RealtimeSessionConfig>,
): Partial<RealtimeSessionConfigDefinition> {
  if (!isDeprecatedConfig(config)) {
    const inputConfig = config.audio?.input
      ? {
          format: normalizeAudioFormat(config.audio.input.format),
          noiseReduction: config.audio.input.noiseReduction ?? null,
          transcription: config.audio.input.transcription,
          turnDetection: config.audio.input.turnDetection,
        }
      : undefined;

    const requestedOutputVoice = config.audio?.output?.voice ?? config.voice;
    const outputConfig =
      config.audio?.output || typeof requestedOutputVoice !== 'undefined'
        ? {
            format: normalizeAudioFormat(config.audio?.output?.format),
            voice: requestedOutputVoice,
            speed: config.audio?.output?.speed,
          }
        : undefined;

    return {
      model: config.model,
      instructions: config.instructions,
      toolChoice: config.toolChoice,
      tools: config.tools,
      tracing: config.tracing,
      providerData: config.providerData,
      prompt: config.prompt,
      outputModalities: config.outputModalities,
      audio:
        inputConfig || outputConfig
          ? {
              input: inputConfig,
              output: outputConfig,
            }
          : undefined,
    };
  }

  return {
    model: config.model,
    instructions: config.instructions,
    toolChoice: config.toolChoice,
    tools: config.tools,
    tracing: config.tracing,
    providerData: config.providerData,
    prompt: config.prompt,
    outputModalities: config.modalities,
    audio: {
      input: {
        format: normalizeAudioFormat(config.inputAudioFormat),
        noiseReduction: config.inputAudioNoiseReduction ?? null,
        transcription: config.inputAudioTranscription,
        turnDetection: config.turnDetection,
      },
      output: {
        format: normalizeAudioFormat(config.outputAudioFormat),
        voice: config.voice,
        speed: config.speed,
      },
    },
  };
}

export function normalizeAudioFormat(
  format?: RealtimeAudioFormat | undefined,
): RealtimeAudioFormatDefinition | undefined {
  if (!format) return undefined;
  if (typeof format === 'object')
    return format as RealtimeAudioFormatDefinition;
  const f = String(format);
  if (f === 'pcm16') return { type: 'audio/pcm', rate: 24000 };
  if (f === 'g711_ulaw') return { type: 'audio/pcmu' };
  if (f === 'g711_alaw') return { type: 'audio/pcma' };
  // Default fallback: assume 24kHz PCM if unknown string
  return { type: 'audio/pcm', rate: 24000 };
}

export type FunctionToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObjectSchema<any>;
  strict: boolean;
};

export type HostedToolFilter = {
  tool_names?: string[];
};

// TODO unify this with the core types
export type HostedMCPToolDefinition = {
  type: 'mcp';
  server_label: string;
  server_url?: string;
  headers?: Record<string, string>;
  allowed_tools?: string[] | HostedToolFilter;
  require_approval?:
    | 'never'
    | 'always'
    | {
        never?: HostedToolFilter;
        always?: HostedToolFilter;
      };
};

export type RealtimeToolDefinition =
  | FunctionToolDefinition
  | HostedMCPToolDefinition;

// Describes a tool as returned by an MCP server (via mcp_list_tools).
// Shape mirrors the realtime event payload (with room for extensions).
export type RealtimeMcpToolInfo = {
  name: string;
  description?: string;
  input_schema?: Record<string, any>;
  [key: string]: any;
};
