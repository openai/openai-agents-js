import { UserError } from '@openai/agents-core';
import type { RealtimeTransportLayerConnectOptions } from './transportLayer';
import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
} from './openaiRealtimeWebsocket';
import type { RealtimeSessionPayload } from './openaiRealtimeBase';
import type { RealtimeSessionConfig } from './clientMessages';
import {
  RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeContextData,
} from './realtimeSession';
import { RealtimeAgent } from './realtimeAgent';

const SIP_UNSUPPORTED_TURN_DETECTION_FIELDS = [
  ['threshold', 'threshold'],
  ['prefix_padding_ms', 'prefixPaddingMs/prefix_padding_ms'],
  ['silence_duration_ms', 'silenceDurationMs/silence_duration_ms'],
] as const;

function formatFieldList(fields: string[]): string {
  if (fields.length <= 1) {
    return fields[0] ?? '';
  }

  if (fields.length === 2) {
    return `${fields[0]} and ${fields[1]}`;
  }

  return `${fields.slice(0, -1).join(', ')}, and ${fields.at(-1)}`;
}

/**
 * Transport layer that connects to an existing SIP-initiated Realtime call via call ID.
 */
export class OpenAIRealtimeSIP extends OpenAIRealtimeWebSocket {
  constructor(options: OpenAIRealtimeWebSocketOptions = {}) {
    super(options);
  }

  /**
   * Build the initial session payload for a SIP-attached session, matching the config that a RealtimeSession would send on connect.
   *
   * This enables SIP deployments to accept an incoming call with a payload that already reflects
   * the active agent's instructions, tools, prompt, and tracing metadata without duplicating the
   * session logic outside of the SDK. The returned object structurally matches the REST
   * `CallAcceptParams` interface, so it can be forwarded directly to
   * `openai.realtime.calls.accept(...)`.
   *
   * @param agent - The starting agent used to seed the session instructions, tools, and prompt.
   * @param options - Optional session options that mirror the ones passed to the RealtimeSession constructor.
   * @param overrides - Additional config overrides applied on top of the session options.
   */
  static async buildInitialConfig<TBaseContext = unknown>(
    agent:
      | RealtimeAgent<TBaseContext>
      | RealtimeAgent<RealtimeContextData<TBaseContext>>,
    options: Partial<RealtimeSessionOptions<TBaseContext>> = {},
    overrides: Partial<RealtimeSessionConfig> = {},
  ): Promise<RealtimeSessionPayload> {
    const sessionConfig = await RealtimeSession.computeInitialSessionConfig(
      agent,
      options,
      overrides,
    );
    const transport = new OpenAIRealtimeSIP();
    const payload = transport.buildSessionPayload(sessionConfig);
    OpenAIRealtimeSIP.assertSupportedInitialConfigPayload(payload);
    return payload;
  }

  override sendAudio(
    _audio: ArrayBuffer,
    _options: { commit?: boolean } = {},
  ): never {
    // SIP integrations stream audio to OpenAI directly through the telephony provider, so the
    // transport deliberately prevents userland code from sending duplicate buffers.
    throw new Error(
      'OpenAIRealtimeSIP does not support sending audio buffers; audio is handled by the SIP call.',
    );
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    if (!options.callId) {
      throw new UserError(
        'OpenAIRealtimeSIP requires `callId` in the connect options.',
      );
    }

    await super.connect(options);
  }

  private static assertSupportedInitialConfigPayload(
    payload: RealtimeSessionPayload,
  ): void {
    const turnDetection = payload.audio?.input?.turn_detection as
      | Record<string, unknown>
      | null
      | undefined;

    if (!turnDetection || typeof turnDetection !== 'object') {
      return;
    }

    const unsupportedFields = SIP_UNSUPPORTED_TURN_DETECTION_FIELDS.flatMap(
      ([key, label]) =>
        typeof turnDetection[key] === 'undefined' ? [] : [label],
    );

    if (unsupportedFields.length === 0) {
      return;
    }

    throw new UserError(
      `OpenAIRealtimeSIP.buildInitialConfig() does not support SIP turn-detection fields ${formatFieldList(unsupportedFields)}. The Realtime Calls API rejects these session.audio.input.turn_detection properties for SIP sessions, so remove them before accepting the call.`,
    );
  }
}
