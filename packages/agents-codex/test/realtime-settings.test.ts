import { describe, expect, it } from 'vitest';
import {
  type NativeRealtimeSessionUpdate,
  serializeRealtimeSessionUpdate,
  serializeRealtimeSettings,
} from '../src/runtime/realtime-settings';

describe('native Realtime settings serialization', () => {
  it.each(['server_vad', 'semantic_vad'] as const)(
    'preserves %s model versions for startup and sparse updates',
    (type) => {
      const turnDetection = { type, modelVersion: 'fixture-vad-v2' };
      const expected = {
        turn_detection: { type, model_version: 'fixture-vad-v2' },
      };
      expect(serializeRealtimeSettings({ turnDetection })).toEqual(expected);
      expect(serializeRealtimeSessionUpdate({ turnDetection })).toEqual(
        expected,
      );
      expect(serializeRealtimeSettings({ turnDetection: { type } })).toEqual({
        turn_detection: { type },
      });
    },
  );

  it('preserves omitted versus disabled settings and sends sparse updates', () => {
    expect(serializeRealtimeSettings({})).toEqual({});
    expect(serializeRealtimeSessionUpdate({ outputSpeed: 1.25 })).toEqual({
      output_speed: 1.25,
    });
    expect(
      serializeRealtimeSettings({
        turnDetection: null,
        noiseReduction: null,
        transcription: null,
        tracing: null,
        prompt: null,
      }),
    ).toEqual({
      turn_detection: null,
      noise_reduction: null,
      transcription: null,
      tracing: null,
      prompt: null,
    });
    expect(
      serializeRealtimeSettings({
        outputSpeed: undefined,
        transcription: { model: undefined },
      }),
    ).toEqual({ transcription: {} });
  });

  it('maps all declared fields while preserving arbitrary variable and metadata keys', () => {
    const update: NativeRealtimeSessionUpdate = {
      inputFormat: 'g711_ulaw',
      outputFormat: 'g711_alaw',
      noiseReduction: { type: 'far_field' },
      transcription: {
        model: 'gpt-transcribe',
        language: 'en',
        prompt: 'names',
        keywords: ['Codex'],
        languages: ['en', 'es'],
        delay: 'low',
      },
      turnDetection: {
        type: 'server_vad',
        createResponse: false,
        interruptResponse: false,
        threshold: 0,
        prefixPaddingMs: 0,
        silenceDurationMs: 500,
        idleTimeoutMs: 10000,
      },
      outputVoice: { id: 'voice_123' },
      outputSpeed: 0.75,
      prompt: {
        id: 'pmpt_123',
        version: '2',
        variables: {
          camelCase: 'Paris',
          text: { type: 'input_text', text: 'hello' },
          image: {
            type: 'input_image',
            imageUrl: 'https://example.com/a.png',
            detail: 'auto',
          },
          file: {
            type: 'input_file',
            fileId: 'file_123',
            fileUrl: 'https://example.com/a.pdf',
            fileData: 'data',
            filename: 'a.pdf',
          },
        },
      },
      tracing: {
        workflowName: 'voice',
        groupId: 'group_123',
        metadata: { camelCase: true },
      },
      maxOutputTokens: 'inf',
      parallelToolCalls: false,
      reasoning: { effort: 'high' },
      model: 'gpt-realtime',
      instructions: 'brief',
      outputModality: 'audio',
    };
    expect(serializeRealtimeSessionUpdate(update)).toEqual({
      input_format: 'g711_ulaw',
      output_format: 'g711_alaw',
      noise_reduction: { type: 'far_field' },
      transcription: {
        model: 'gpt-transcribe',
        language: 'en',
        prompt: 'names',
        keywords: ['Codex'],
        languages: ['en', 'es'],
        delay: 'low',
      },
      turn_detection: {
        type: 'server_vad',
        create_response: false,
        interrupt_response: false,
        threshold: 0,
        prefix_padding_ms: 0,
        silence_duration_ms: 500,
        idle_timeout_ms: 10000,
      },
      output_voice: { id: 'voice_123' },
      output_speed: 0.75,
      prompt: {
        id: 'pmpt_123',
        version: '2',
        variables: {
          camelCase: 'Paris',
          text: { type: 'input_text', text: 'hello' },
          image: {
            type: 'input_image',
            image_url: 'https://example.com/a.png',
            detail: 'auto',
          },
          file: {
            type: 'input_file',
            file_id: 'file_123',
            file_url: 'https://example.com/a.pdf',
            file_data: 'data',
            filename: 'a.pdf',
          },
        },
      },
      tracing: {
        workflow_name: 'voice',
        group_id: 'group_123',
        metadata: { camelCase: true },
      },
      max_output_tokens: 'inf',
      parallel_tool_calls: false,
      reasoning: { effort: 'high' },
      model: 'gpt-realtime',
      instructions: 'brief',
      output_modality: 'audio',
    });
    expect(
      serializeRealtimeSettings({
        turnDetection: { type: 'semantic_vad', eagerness: 'high' },
        tracing: 'auto',
        outputVoice: 'marin',
        inputFormat: 'pcm16',
      }),
    ).toEqual({
      turn_detection: { type: 'semantic_vad', eagerness: 'high' },
      tracing: 'auto',
      output_voice: 'marin',
      input_format: 'pcm16',
    });
  });

  it('detaches dynamic data and does not reinterpret schema-like metadata keys', () => {
    const values = [1];
    const encoded = serializeRealtimeSettings({
      tracing: { metadata: { outputSpeed: values } },
    });
    values.push(2);
    expect(encoded).toEqual({ tracing: { metadata: { outputSpeed: [1] } } });
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects nonfinite numbers before JSON can turn them into null: %s',
    (value) => {
      for (const settings of [
        { outputSpeed: value },
        { turnDetection: { type: 'server_vad' as const, threshold: value } },
        { tracing: { metadata: { value } } },
        { maxOutputTokens: value },
      ])
        expect(() => serializeRealtimeSettings(settings)).toThrow(TypeError);
    },
  );
  it('rejects invalid nested tracing scalars and arrays before they become empty config', () => {
    for (const tracing of ['disabled', [], ['auto'], 1, false, new Date()]) {
      expect(() => serializeRealtimeSettings({ tracing } as never)).toThrow(
        TypeError,
      );
    }
    expect(serializeRealtimeSettings({ tracing: null })).toEqual({
      tracing: null,
    });
    expect(serializeRealtimeSettings({ tracing: 'auto' })).toEqual({
      tracing: 'auto',
    });
    for (const field of [
      'transcription',
      'turnDetection',
      'prompt',
      'reasoning',
    ]) {
      expect(() => serializeRealtimeSettings({ [field]: [] } as never)).toThrow(
        TypeError,
      );
      expect(() =>
        serializeRealtimeSettings({ [field]: 'invalid' } as never),
      ).toThrow(TypeError);
    }
  });
  it('serializes URL and connector hosted MCP declarations without changing data keys', () => {
    const names = ['read_file'];
    const headers = { 'X-Session-Name': 'opaque' };
    const settings = serializeRealtimeSettings({
      hostedMcpTools: [
        {
          serverLabel: 'docs',
          serverUrl: 'https://mcp.example.com',
          headers,
          authorization: 'token',
          serverDescription: 'Reference',
          allowedTools: { toolNames: names, readOnly: true },
          requireApproval: {
            always: { toolNames: ['write_file'] },
            never: { readOnly: true },
          },
        },
        {
          serverLabel: 'drive',
          connectorId: 'connector_drive',
          allowedTools: ['search'],
          requireApproval: 'always',
        },
      ],
    });
    names.push('later');
    headers['X-Session-Name'] = 'changed';
    expect(settings).toEqual({
      hosted_mcp_tools: [
        {
          server_label: 'docs',
          server_url: 'https://mcp.example.com',
          headers: { 'X-Session-Name': 'opaque' },
          authorization: 'token',
          server_description: 'Reference',
          allowed_tools: { tool_names: ['read_file'], read_only: true },
          require_approval: {
            always: { tool_names: ['write_file'] },
            never: { read_only: true },
          },
        },
        {
          server_label: 'drive',
          connector_id: 'connector_drive',
          allowed_tools: ['search'],
          require_approval: 'always',
        },
      ],
    });
    expect(serializeRealtimeSessionUpdate({ hostedMcpTools: [] })).toEqual({
      hosted_mcp_tools: [],
    });
    expect(serializeRealtimeSessionUpdate({})).not.toHaveProperty(
      'hosted_mcp_tools',
    );
  });

  it('rejects ambiguous hosted MCP targets and credentials before a native call', () => {
    for (const row of [
      { serverLabel: 'docs' },
      {
        serverLabel: 'docs',
        serverUrl: 'https://example.com',
        connectorId: 'connector',
      },
      { serverLabel: 'docs', serverUrl: '' },
      {
        serverLabel: 'docs',
        serverUrl: 'https://example.com',
        authorization: 'token',
        headers: { Authorization: 'other' },
      },
      {
        serverLabel: 'docs',
        serverUrl: 'https://example.com',
        headers: { 'X-Key': 'a', 'x-key': 'b' },
      },
      { serverLabel: 'docs', connectorId: 'connector', headers: [] },
    ])
      expect(() =>
        serializeRealtimeSettings({ hostedMcpTools: [row] } as never),
      ).toThrow(TypeError);
  });
});

describe('native Realtime tool choice', () => {
  it.each([
    'auto',
    'none',
    'required',
    { type: 'function', name: 'weather' },
  ] as const)(
    'serializes a typed sparse choice %j without adding tools',
    (toolChoice) => {
      expect(serializeRealtimeSettings({ toolChoice })).toEqual({
        tool_choice: toolChoice,
      });
      expect(serializeRealtimeSessionUpdate({ toolChoice })).toEqual({
        tool_choice: toolChoice,
      });
      expect(serializeRealtimeSettings({})).toEqual({});
    },
  );
  it.each([
    null,
    'weather',
    [],
    { type: 'mcp', name: 'weather' },
    { type: 'function' },
  ])('rejects unsupported choice %j before native I/O', (toolChoice) => {
    expect(() => serializeRealtimeSettings({ toolChoice } as never)).toThrow();
  });
});
