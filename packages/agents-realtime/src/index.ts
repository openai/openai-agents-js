import * as utilImport from './utils';

export { RealtimeAgent, RealtimeAgentConfiguration } from './realtimeAgent';

export {
  RealtimeSession,
  RealtimeSessionConnectOptions,
  RealtimeSessionOptions,
  RealtimeContextData,
} from './realtimeSession';

export { RealtimeSessionEventTypes } from './realtimeSessionEvents';

export {
  TransportEvent,
  TransportLayerAudio,
  TransportLayerResponseCompleted,
  TransportLayerResponseStarted,
  TransportLayerTranscriptDelta,
  TransportError,
  TransportToolCallEvent,
  RealtimeTransportEventTypes,
} from './transportLayerEvents';

export {
  RealtimeClientMessage,
  RealtimeAudioFormat,
  RealtimeSessionConfig,
} from './clientMessages';

export {
  OpenAIRealtimeWebRTC,
  OpenAIRealtimeWebRTCOptions,
  WebRTCState,
} from './openaiRealtimeWebRtc';

export {
  OpenAIRealtimeWebSocket,
  OpenAIRealtimeWebSocketOptions,
  WebSocketState,
} from './openaiRealtimeWebsocket';

export { OpenAIRealtimeSIP } from './openaiRealtimeSip';

export {
  OpenAIRealtimeModels,
  OpenAIRealtimeBase,
  OpenAIRealtimeBaseOptions,
  OpenAIRealtimeEventTypes,
  DEFAULT_OPENAI_REALTIME_MODEL,
  DEFAULT_OPENAI_REALTIME_SESSION_CONFIG,
  RealtimeSessionPayload,
} from './openaiRealtimeBase';

export { RealtimeOutputGuardrail } from './guardrail';

export {
  RealtimeItem,
  RealtimeToolCallItem,
  RealtimeMessageItem,
  RealtimeBaseItem,
  RealtimeMcpCallItem,
} from './items';

export {
  ApiKey,
  RealtimeTransportLayerConnectOptions,
  RealtimeTransportLayer,
} from './transportLayer';

export const utils = {
  base64ToArrayBuffer: utilImport.base64ToArrayBuffer,
  arrayBufferToBase64: utilImport.arrayBufferToBase64,
  getLastTextFromAudioOutputMessage:
    utilImport.getLastTextFromAudioOutputMessage,
};

// Re-exporting some core functionalities requires for building front-end
// realtime agents
export {
  FunctionTool,
  ModelBehaviorError,
  OutputGuardrailTripwireTriggered,
  tool,
  UserError,
} from '@openai/agents-core';

export { backgroundResult, isBackgroundResult } from './tool';
