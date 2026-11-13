import { copyJsonValue, type JsonObject, type JsonValue } from './binding';

export type NativeRealtimeTranscription = {
  readonly model?: string;
  readonly language?: string;
  readonly prompt?: string;
  readonly keywords?: readonly string[];
  readonly languages?: readonly string[];
  readonly delay?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

export type NativeRealtimeTurnDetection =
  | {
      readonly type: 'server_vad';
      /** Vendor VAD tuning only; typed keys cannot be overridden. */
      readonly providerData?: Readonly<Record<string, JsonValue>> | null;
      readonly modelVersion?: string;
      readonly createResponse?: boolean;
      readonly interruptResponse?: boolean;
      readonly threshold?: number;
      readonly prefixPaddingMs?: number;
      readonly silenceDurationMs?: number;
      readonly idleTimeoutMs?: number;
    }
  | {
      readonly type: 'semantic_vad';
      /** Vendor VAD tuning only; typed keys cannot be overridden. */
      readonly providerData?: Readonly<Record<string, JsonValue>> | null;
      readonly modelVersion?: string;
      readonly createResponse?: boolean;
      readonly interruptResponse?: boolean;
      readonly eagerness?: 'auto' | 'low' | 'medium' | 'high';
    };

export type NativeRealtimePromptVariable =
  | string
  | { readonly type: 'input_text'; readonly text: string }
  | {
      readonly type: 'input_image';
      readonly imageUrl?: string;
      readonly fileId?: string;
      readonly detail?: 'auto' | 'low' | 'high' | 'original';
    }
  | {
      readonly type: 'input_file';
      readonly fileUrl?: string;
      readonly fileId?: string;
      readonly fileData?: string;
      readonly filename?: string;
    };

export type NativeRealtimePrompt = {
  readonly id: string;
  readonly version?: string;
  readonly variables?: Readonly<Record<string, NativeRealtimePromptVariable>>;
};

export type NativeRealtimeTracing = {
  readonly workflowName?: string;
  readonly groupId?: string;
  readonly metadata?: JsonValue;
};

export type NativeRealtimeMcpToolFilter = {
  readonly toolNames?: readonly string[];
  readonly readOnly?: boolean;
};

/** Hosted MCP declarations are provider tools, separate from native Agent functions. */
export type NativeRealtimeHostedMcpTool = {
  readonly serverLabel: string;
  readonly serverDescription?: string;
  readonly authorization?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowedTools?: readonly string[] | NativeRealtimeMcpToolFilter;
  readonly requireApproval?:
    | 'always'
    | 'never'
    | {
        readonly always?: NativeRealtimeMcpToolFilter;
        readonly never?: NativeRealtimeMcpToolFilter;
      };
} & (
  | { readonly serverUrl: string; readonly connectorId?: never }
  | { readonly connectorId: string; readonly serverUrl?: never }
);

export type NativeRealtimeToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'function'; readonly name: string }
  | {
      readonly type: 'mcp';
      readonly serverLabel: string;
      readonly name?: string;
    };

/** Sparse settings; omission retains state and null explicitly disables a setting. */
export type NativeRealtimeSettings = {
  /** Extra provider wire fields. Native settings and identities stay reserved. */
  readonly providerData?: Readonly<Record<string, JsonValue>>;
  readonly inputFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  readonly outputFormat?: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
  readonly noiseReduction?: {
    readonly type: 'near_field' | 'far_field';
  } | null;
  readonly transcription?: NativeRealtimeTranscription | null;
  readonly turnDetection?: NativeRealtimeTurnDetection | null;
  readonly outputVoice?: string | { readonly id: string };
  readonly outputSpeed?: number;
  readonly prompt?: NativeRealtimePrompt | null;
  /** Provider tracing, independent of client SDK span export. */
  readonly tracing?: 'auto' | NativeRealtimeTracing | null;
  readonly maxOutputTokens?: number | 'inf';
  readonly parallelToolCalls?: boolean;
  readonly toolChoice?: NativeRealtimeToolChoice;
  /** Omission retains hosted tools; an empty array clears only hosted tools. */
  readonly hostedMcpTools?: readonly NativeRealtimeHostedMcpTool[];
  readonly reasoning?: { readonly effort?: string };
};

export type NativeRealtimeSessionUpdate = NativeRealtimeSettings & {
  readonly model?: string;
  readonly instructions?: string;
  readonly outputModality?: 'audio' | 'text';
};

// Map only declared schema fields; prompt variable names and metadata are data.
function fields(
  value: object,
  names: readonly (string | readonly [string, string])[],
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError('Realtime settings must contain plain objects');
  return Object.fromEntries(
    names.flatMap((name) => {
      const [source, target] = typeof name === 'string' ? [name, name] : name;
      if (!Object.hasOwn(value, source)) return [];
      const item = (value as Record<string, unknown>)[source];
      return item === undefined ? [] : [[target, item]];
    }),
  );
}

const vadTypedKeys = new Set(
  (
    'type model_version modelVersion create_response createResponse interrupt_response ' +
    'interruptResponse threshold prefix_padding_ms prefixPaddingMs silence_duration_ms ' +
    'silenceDurationMs idle_timeout_ms idleTimeoutMs eagerness provider_data providerData'
  ).split(' '),
);

function mcpFilter(
  value: NativeRealtimeMcpToolFilter,
): Record<string, unknown> {
  return fields(value, [
    ['toolNames', 'tool_names'],
    ['readOnly', 'read_only'],
  ]);
}

function hostedMcpTool(
  value: NativeRealtimeHostedMcpTool,
): Record<string, unknown> {
  const result = fields(value, [
    ['serverLabel', 'server_label'],
    ['serverUrl', 'server_url'],
    ['connectorId', 'connector_id'],
    ['serverDescription', 'server_description'],
    'authorization',
    'headers',
  ]);
  const hasUrl = value.serverUrl !== undefined;
  const hasConnector = value.connectorId !== undefined;
  if (
    hasUrl === hasConnector ||
    typeof value.serverLabel !== 'string' ||
    !value.serverLabel.trim() ||
    (hasUrl &&
      (typeof value.serverUrl !== 'string' || !value.serverUrl.trim())) ||
    (hasConnector &&
      (typeof value.connectorId !== 'string' || !value.connectorId.trim()))
  )
    throw new TypeError(
      'Hosted MCP tools require a server label and exactly one URL or connector',
    );
  if (value.headers !== undefined) {
    fields(value.headers, []);
    const names = new Set<string>();
    for (const [name, header] of Object.entries(value.headers)) {
      const key = name.toLowerCase();
      if (names.has(key) || typeof header !== 'string')
        throw new TypeError(
          'Hosted MCP headers require distinct case-insensitive names and string values',
        );
      names.add(key);
    }
    if (value.authorization !== undefined && names.has('authorization'))
      throw new TypeError(
        'Hosted MCP authorization cannot also appear in headers',
      );
  }
  if (
    value.authorization !== undefined &&
    typeof value.authorization !== 'string'
  )
    throw new TypeError('Hosted MCP authorization must be a string');
  if (value.allowedTools !== undefined)
    result.allowed_tools = Array.isArray(value.allowedTools)
      ? value.allowedTools
      : mcpFilter(value.allowedTools as NativeRealtimeMcpToolFilter);
  if (value.requireApproval !== undefined)
    result.require_approval =
      typeof value.requireApproval === 'string'
        ? value.requireApproval
        : Object.fromEntries(
            Object.entries(
              fields(value.requireApproval, ['always', 'never']),
            ).map(([key, filter]) => [
              key,
              mcpFilter(filter as NativeRealtimeMcpToolFilter),
            ]),
          );
  return result;
}

function settingsObject(
  settings: NativeRealtimeSettings,
): Record<string, unknown> {
  const result = fields(settings, [
    ['providerData', 'provider_data'],
    ['inputFormat', 'input_format'],
    ['outputFormat', 'output_format'],
    ['noiseReduction', 'noise_reduction'],
    ['outputVoice', 'output_voice'],
    ['outputSpeed', 'output_speed'],
    ['maxOutputTokens', 'max_output_tokens'],
    ['parallelToolCalls', 'parallel_tool_calls'],
  ]);
  if (settings.toolChoice !== undefined) {
    const choice = settings.toolChoice;
    if (choice === 'auto' || choice === 'none' || choice === 'required')
      result.tool_choice = choice;
    else {
      const named = fields(choice, [
        'type',
        'name',
        ['serverLabel', 'server_label'],
      ]);
      const keys = Object.keys(choice);
      const functionChoice =
        named.type === 'function' &&
        typeof named.name === 'string' &&
        keys.length === 2;
      const mcpChoice =
        named.type === 'mcp' &&
        typeof named.server_label === 'string' &&
        (named.name === undefined || typeof named.name === 'string') &&
        keys.every(
          (key) => key === 'type' || key === 'serverLabel' || key === 'name',
        );
      if (!functionChoice && !mcpChoice)
        throw new TypeError(
          'toolChoice must be auto, none, required, a function, or an MCP tool',
        );
      result.tool_choice = named;
    }
  }
  if (settings.hostedMcpTools !== undefined) {
    if (!Array.isArray(settings.hostedMcpTools))
      throw new TypeError('Hosted MCP tools must be an array');
    result.hosted_mcp_tools = settings.hostedMcpTools.map(hostedMcpTool);
  }
  if (settings.transcription !== undefined)
    result.transcription =
      settings.transcription === null
        ? null
        : fields(settings.transcription, [
            'model',
            'language',
            'prompt',
            'keywords',
            'languages',
            'delay',
          ]);
  if (settings.turnDetection !== undefined)
    result.turn_detection =
      settings.turnDetection === null
        ? null
        : fields(settings.turnDetection, [
            'type',
            ['modelVersion', 'model_version'],
            ['createResponse', 'create_response'],
            ['interruptResponse', 'interrupt_response'],
            'threshold',
            ['prefixPaddingMs', 'prefix_padding_ms'],
            ['silenceDurationMs', 'silence_duration_ms'],
            ['idleTimeoutMs', 'idle_timeout_ms'],
            'eagerness',
          ]);
  if (settings.turnDetection?.providerData !== undefined) {
    const data = settings.turnDetection.providerData;
    if (data !== null) {
      fields(data, []);
      if (Object.keys(data).some((key) => vadTypedKeys.has(key)))
        throw new TypeError('VAD providerData cannot override typed settings');
    }
    (result.turn_detection as Record<string, unknown>).provider_data = data;
  }
  if (settings.reasoning !== undefined)
    result.reasoning = fields(settings.reasoning, ['effort']);
  if (settings.tracing !== undefined)
    result.tracing =
      settings.tracing === null || settings.tracing === 'auto'
        ? settings.tracing
        : fields(settings.tracing, [
            ['workflowName', 'workflow_name'],
            ['groupId', 'group_id'],
            'metadata',
          ]);
  if (settings.prompt !== undefined) {
    if (settings.prompt === null) result.prompt = null;
    else {
      const prompt = fields(settings.prompt, ['id', 'version']);
      if (settings.prompt.variables !== undefined)
        prompt.variables = Object.fromEntries(
          Object.entries(settings.prompt.variables).map(([name, value]) => [
            name,
            typeof value === 'string'
              ? value
              : fields(value, [
                  'type',
                  'text',
                  ['imageUrl', 'image_url'],
                  ['fileId', 'file_id'],
                  'detail',
                  ['fileUrl', 'file_url'],
                  ['fileData', 'file_data'],
                  'filename',
                ]),
          ]),
        );
      result.prompt = prompt;
    }
  }
  return result;
}

/** Return detached canonical DTO data, rejecting nonfinite numbers before a native call. */
export function serializeRealtimeSettings(
  settings: NativeRealtimeSettings,
): JsonObject {
  return copyJsonValue(settingsObject(settings)) as JsonObject;
}

/** Serialize named changes only; the result is not a provider event envelope. */
export function serializeRealtimeSessionUpdate(
  update: NativeRealtimeSessionUpdate,
): JsonObject {
  return copyJsonValue({
    ...settingsObject(update),
    ...fields(update, [
      'model',
      'instructions',
      ['outputModality', 'output_modality'],
    ]),
  }) as JsonObject;
}
