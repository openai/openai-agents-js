import { protocol, Usage } from '@openai/agents-core';
import { RealtimeBaseItem, RealtimeItem } from './items';

/**
 * Represents an error that occurred on the transport layer.
 */
export type TransportError = {
  type: 'error';
  error: unknown;
};

/**
 * Event representing an attempted tool call by the model on the transport layer.
 */
export type TransportToolCallEvent = {
  id?: string;
  type: 'function_call';
  name: string;
  callId: string;
  arguments: string;
  previousItemId?: string;
};

/**
 * Event representing audio data from the model on the transport layer.
 */
export type TransportLayerAudio = {
  type: 'audio';
  data: ArrayBuffer;
  responseId: string;
};

export type TransportLayerTranscriptDelta = {
  type: 'transcript_delta';
  itemId: string;
  delta: string;
  responseId: string;
};

export type TransportLayerResponseCompleted =
  protocol.StreamEventResponseCompleted;
export type TransportLayerResponseStarted = protocol.StreamEventResponseStarted;

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type TransportEvent =
  | TransportError
  | TransportToolCallEvent
  | {
      type: string;
      [key: string]: any;
    };

export type RealtimeTranportEventTypes = {
  /**
   * A raw event from the transport layer. Allows a user to tap directly into the events of the
   * transport layer.
   */
  '*': [event: TransportEvent];

  /**
   * Triggered if the model / transport layer encountered an error
   */
  error: [error: TransportError];

  /**
   * Triggered when the model is trying to call a function.
   */
  function_call: [event: TransportToolCallEvent];

  /**
   * Triggered when there is new audio data available. Might not be triggered if the transport layer
   * handles the audio internally (WebRTC).
   */
  audio: [event: TransportLayerAudio];

  /**
   * Triggered when the model detected that it was interrupted. This can be used by the client
   * to stop audio playback.
   */
  audio_interrupted: [];

  /**
   * Triggered when there is a new text delta of the transcript available.
   */
  audio_transcript_delta: [deltaEvent: TransportLayerTranscriptDelta];

  /**
   * Triggered when the audio generation is done.
   */
  audio_done: [];

  /**
   * Triggered when the usage update is available.
   */
  usage_update: [usage: Usage];

  /**
   * Triggered when the history is added or updated.
   */
  item_update: [item: RealtimeItem];

  /**
   * Triggered when an item is deleted.
   */
  item_deleted: [item: RealtimeBaseItem];

  /**
   * Triggered whenever the connection status of the transport changes.
   * Emits the new status after the change.
   */
  connection_change: [status: ConnectionStatus];

  /**
   * Triggered when the model starts generating a response for a turn.
   */
  turn_started: [event: TransportLayerResponseStarted];

  /**
   * Triggered when the model is done generating a response for a turn.
   */
  turn_done: [event: TransportLayerResponseCompleted];

  [key: string]: [...args: any[]];
};
