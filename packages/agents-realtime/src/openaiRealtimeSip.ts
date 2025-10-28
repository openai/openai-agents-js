import { UserError } from '@openai/agents-core';
import type { RealtimeTransportLayerConnectOptions } from './transportLayer';
import {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
} from './openaiRealtimeWebsocket';

/**
 * Transport layer that connects to an existing SIP-initiated Realtime call via call ID.
 */
export class OpenAIRealtimeSIP extends OpenAIRealtimeWebSocket {
  constructor(options: OpenAIRealtimeWebSocketOptions = {}) {
    super(options);
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    if (!options.callId) {
      throw new UserError(
        'OpenAIRealtimeSIP requires `callId` in the connect options.',
      );
    }

    await super.connect(options);
  }
}
