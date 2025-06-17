import {
  JsonObjectSchema,
  ModelSettingsToolChoice,
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
      content: {
        type: 'input_text';
        text: string;
      }[];
    };

export type RealtimeAudioFormat =
  | 'pcm16'
  | 'g711_ulaw'
  | 'g711_alaw'
  | (string & {});

export type RealtimeTracingConfig =
  | {
      workflow_name?: string;
      group_id?: string;
      metadata?: Record<string, any>;
    }
  | 'auto';

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
  type?: 'semantic_vad' | 'server_vad';
  create_response?: boolean;
  eagerness?: 'auto' | 'low' | 'medium' | 'high';
  interrupt_response?: boolean;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  threshold?: number;
};

// The Realtime API accepts snake_cased keys, so when using this, this SDK coverts the keys to snake_case ones before passing it to the API
export type RealtimeTurnDetectionConfigCamelCase = {
  type?: 'semantic_vad' | 'server_vad';
  createResponse?: boolean;
  eagerness?: 'auto' | 'low' | 'medium' | 'high';
  interruptResponse?: boolean;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  threshold?: number;
};

export type RealtimeTurnDetectionConfig = (
  | RealtimeTurnDetectionConfigAsIs
  | RealtimeTurnDetectionConfigCamelCase
) &
  Record<string, any>;

export type RealtimeSessionConfig = {
  model: string;
  instructions: string;
  modalities: ('text' | 'audio')[];
  voice: string;
  inputAudioFormat: RealtimeAudioFormat;
  outputAudioFormat: RealtimeAudioFormat;
  inputAudioTranscription: RealtimeInputAudioTranscriptionConfig;
  turnDetection: RealtimeTurnDetectionConfig;
  toolChoice: ModelSettingsToolChoice;
  tools: FunctionToolDefinition[];
  tracing?: RealtimeTracingConfig | null;
  providerData?: Record<string, any>;
};

export type FunctionToolDefinition = {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonObjectSchema<any>;
  strict: boolean;
};
