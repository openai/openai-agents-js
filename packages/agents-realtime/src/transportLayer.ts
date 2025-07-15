import { EventEmitter } from '@openai/agents-core/_shims';
import {
  RealtimeClientMessage,
  RealtimeSessionConfig,
  RealtimeUserInput,
} from './clientMessages';
import { RealtimeItem } from './items';
import {
  RealtimeTransportEventTypes,
  TransportToolCallEvent,
} from './transportLayerEvents';

/**
 * The type of the API key. Can be a string or a function that returns a string or a promise that
 * resolves to a string.
 */
export type ApiKey = string | (() => string | Promise<string>);

/**
 * The options for the connection to the model.
 */
export type RealtimeTransportLayerConnectOptions = {
  /**
   * The API key to use for the connection.
   */
  apiKey: ApiKey;

  /**
   * The model to use for the connection.
   */
  model?: string;

  /**
   * The URL to use for the connection.
   */
  url?: string;

  /**
   * The initial session config to use for the session.
   */
  initialSessionConfig?: Partial<RealtimeSessionConfig>;
};

/**
 * The transport layer is the layer that handles the connection to the model
 * and the communication with the model.
 */
export interface RealtimeTransportLayer
  extends EventEmitter<RealtimeTransportEventTypes> {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting';

  /**
   * Establishes the connection to the model and keeps the connection alive
   * @param options - The options for the connection
   */
  connect(options: RealtimeTransportLayerConnectOptions): Promise<void>;

  /**
   * Whether the input audio track is currently muted
   * null if the muting is not handled by the transport layer
   */
  readonly muted: boolean | null;

  /**
   * Sends a raw event to the model
   * @param event - The event to send
   */
  sendEvent(event: RealtimeClientMessage): void;

  /**
   * Sends a text message to the model
   * @param message - The message to send
   * @param otherEventData - Additional event data, will be merged into the event
   */
  sendMessage(
    message: RealtimeUserInput,
    otherEventData: Record<string, any>,
  ): void;

  /**
   * Sends a raw audio buffer to the model
   * @param audio - The audio buffer to send
   * @param options - Additional options
   * @param options.commit - Whether to commit the audio buffer to the model. If the model does not do turn detection, this can be used to indicate the turn is completed.
   */
  sendAudio(audio: ArrayBuffer, options: { commit?: boolean }): void;

  /**
   * Sends an updated session configuration to the model. Used to update for example the model instructions during a handoff
   * @param config - The new session config
   */
  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void;

  /**
   * Closes the connection to the model
   */
  close(): void;

  /**
   * Mutes the input audio track
   * @param muted - Whether to mute the input audio track
   */
  mute(muted: boolean): void;

  /**
   * Sends a function call output to the model
   * @param toolCall - The tool call to send
   * @param output - The output of the tool call
   */
  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean,
  ): void;

  /**
   * Interrupts the current turn. Used for example when a guardrail is triggered
   */
  interrupt(): void;

  /**
   * Resets the conversation history / context to a specific state
   * @param history - The history to reset to
   */
  resetHistory(oldHistory: RealtimeItem[], newHistory: RealtimeItem[]): void;
}
