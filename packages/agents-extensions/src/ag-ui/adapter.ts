import { ReadableStream, TransformStream } from '@openai/agents-core/_shims';
import type { ReadableStream as ReadableStreamInterface } from '../shims/interface';
import { RunStreamEvent } from '../events';
import { StreamEventTextStream } from '../types/protocol';
import { Agent } from '../agent';
import {
  AGUIEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  ToolCallStartEvent,
  ToolCallEndEvent,
  ToolCallArgsEvent,
  ToolMessageEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  JsonPatchOperation,
} from './types';

export interface AGUIAdapterOptions {
  thread_id?: string;
  run_id?: string;
  includeRawEvents?: boolean;
  includeStateSnapshots?: boolean;
}

export class AGUIAdapter {
  private threadId: string;
  private runId: string;
  private options: AGUIAdapterOptions;
  private messageId: string | undefined;
  private currentAgent: Agent<any, any> | undefined;
  private stepId: string | undefined;
  private previousState: any = {};

  constructor(options: AGUIAdapterOptions = {}) {
    this.threadId = options.thread_id ?? this.generateId();
    this.runId = options.run_id ?? this.generateId();
    this.options = options;
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15);
  }

  private generateMessageId(): string {
    // Generate AG-UI compliant message ID
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateToolCallId(): string {
    // Generate AG-UI compliant tool call ID
    return `tool_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private createBaseEvent(_type: AGUIEvent['type']): Omit<AGUIEvent, 'type'> {
    return {
      timestamp: Date.now(),
    };
  }

  /**
   * Transforms a stream of RunStreamEvent to AG-UI compatible events
   */
  transformToAGUIStream(
    inputStream: ReadableStreamInterface<RunStreamEvent>,
  ): ReadableStream<AGUIEvent> {
    return (inputStream as any).pipeThrough(
      new TransformStream<RunStreamEvent, AGUIEvent>({
        start: (controller) => {
          // Emit RUN_STARTED at the beginning
          const runStarted: RunStartedEvent = {
            ...this.createBaseEvent('RUN_STARTED'),
            type: 'RUN_STARTED',
            thread_id: this.threadId,
            run_id: this.runId,
            agentName: this.currentAgent?.name,
          };
          controller.enqueue(runStarted);
        },

        transform: (event, controller) => {
          const aguiEvents = this.convertToAGUIEvents(event);
          for (const aguiEvent of aguiEvents) {
            controller.enqueue(aguiEvent);
          }
        },

        flush: (controller) => {
          // Emit RUN_FINISHED at the end
          const runFinished: RunFinishedEvent = {
            ...this.createBaseEvent('RUN_FINISHED'),
            type: 'RUN_FINISHED',
            thread_id: this.threadId,
            run_id: this.runId,
          };
          controller.enqueue(runFinished);
        },
      }),
    );
  }

  private convertToAGUIEvents(event: RunStreamEvent): AGUIEvent[] {
    const events: AGUIEvent[] = [];

    switch (event.type) {
      case 'agent_updated_stream_event': {
        // Agent changed - emit step events
        if (this.currentAgent) {
          // End previous step
          const stepFinished: StepFinishedEvent = {
            ...this.createBaseEvent('STEP_FINISHED'),
            type: 'STEP_FINISHED',
            stepId: this.stepId,
            agentName: this.currentAgent.name,
          };
          events.push(stepFinished);
        }

        // Start new step
        this.currentAgent = event.agent;
        this.stepId = this.generateId();
        const stepStarted: StepStartedEvent = {
          ...this.createBaseEvent('STEP_STARTED'),
          type: 'STEP_STARTED',
          stepId: this.stepId,
          agentName: this.currentAgent.name,
        };
        events.push(stepStarted);

        if (this.options.includeStateSnapshots) {
          this.previousState = {
            currentAgent: this.currentAgent.name,
            stepId: this.stepId,
            threadId: this.threadId,
            runId: this.runId,
          };

          const stateSnapshot: StateSnapshotEvent = {
            ...this.createBaseEvent('STATE_SNAPSHOT'),
            type: 'STATE_SNAPSHOT',
            state: this.previousState,
          };
          events.push(stateSnapshot);
        }
        break;
      }

      case 'run_item_stream_event': {
        switch (event.name) {
          case 'message_output_created': {
            // Start of a message
            this.messageId = this.generateMessageId();
            const messageStart: TextMessageStartEvent = {
              ...this.createBaseEvent('TEXT_MESSAGE_START'),
              type: 'TEXT_MESSAGE_START',
              message_id: this.messageId,
              role: 'assistant',
              name:
                event.item.type === 'message_output_item'
                  ? event.item.agent.name
                  : undefined,
            };
            events.push(messageStart);
            break;
          }

          case 'tool_called': {
            if (event.item.type === 'tool_call_item') {
              let toolName = 'unknown';
              if (event.item.rawItem.type === 'function_call') {
                toolName = event.item.rawItem.name;
              } else if (event.item.rawItem.type === 'hosted_tool_call') {
                toolName = event.item.rawItem.name;
              } else if (event.item.rawItem.type === 'computer_call') {
                toolName = 'computer';
              }

              const toolStart: ToolCallStartEvent = {
                ...this.createBaseEvent('TOOL_CALL_START'),
                type: 'TOOL_CALL_START',
                tool_call_id:
                  event.item.rawItem.id || this.generateToolCallId(),
                tool_name: toolName,
              };
              events.push(toolStart);

              // If we have args, emit TOOL_CALL_ARGS event
              if (
                event.item.rawItem.type === 'function_call' &&
                event.item.rawItem.arguments
              ) {
                const toolArgs: ToolCallArgsEvent = {
                  ...this.createBaseEvent('TOOL_CALL_ARGS'),
                  type: 'TOOL_CALL_ARGS',
                  tool_call_id:
                    event.item.rawItem.id || this.generateToolCallId(),
                  args: event.item.rawItem.arguments,
                };
                events.push(toolArgs);
              }
            }
            break;
          }

          case 'tool_output': {
            if (event.item.type === 'tool_call_output_item') {
              // Emit tool message first
              const toolMessage: ToolMessageEvent = {
                ...this.createBaseEvent('TOOL_MESSAGE'),
                type: 'TOOL_MESSAGE',
                message_id: this.generateMessageId(),
                role: 'tool',
                content:
                  typeof event.item.output === 'string'
                    ? event.item.output
                    : JSON.stringify(event.item.output),
                tool_call_id: event.item.rawItem.callId,
              };
              events.push(toolMessage);

              // Then emit tool end
              const toolEnd: ToolCallEndEvent = {
                ...this.createBaseEvent('TOOL_CALL_END'),
                type: 'TOOL_CALL_END',
                tool_call_id: event.item.rawItem.callId,
                result: event.item.output,
                success: true, // Assume success if we got an output
              };
              events.push(toolEnd);
            }
            break;
          }

          case 'handoff_occurred': {
            // Handle handoffs as state changes using JSON Patch
            const handoffPatch: JsonPatchOperation[] = [
              {
                op: 'replace',
                path: '/currentAgent',
                value:
                  event.item.type === 'handoff_output_item'
                    ? event.item.targetAgent.name
                    : undefined,
              },
              {
                op: 'add',
                path: '/lastHandoff',
                value: {
                  from:
                    event.item.type === 'handoff_output_item'
                      ? event.item.sourceAgent.name
                      : undefined,
                  to:
                    event.item.type === 'handoff_output_item'
                      ? event.item.targetAgent.name
                      : undefined,
                  timestamp: Date.now(),
                },
              },
            ];

            const stateDelta: StateDeltaEvent = {
              ...this.createBaseEvent('STATE_DELTA'),
              type: 'STATE_DELTA',
              delta: handoffPatch,
            };
            events.push(stateDelta);
            break;
          }
        }
        break;
      }

      case 'raw_model_stream_event': {
        if (event.data.type === 'output_text_delta') {
          const textData = StreamEventTextStream.parse(event.data);
          const messageContent: TextMessageContentEvent = {
            ...this.createBaseEvent('TEXT_MESSAGE_CONTENT'),
            type: 'TEXT_MESSAGE_CONTENT',
            message_id: this.messageId!,
            delta: textData.delta,
          };
          events.push(messageContent);
        }

        // Include raw event if requested
        if (this.options.includeRawEvents) {
          events.push({
            ...this.createBaseEvent('RAW'),
            type: 'RAW',
            data: event.data,
            rawEvent: event,
          });
        }
        break;
      }
    }

    return events;
  }

  /**
   * Handle errors and convert them to AG-UI error events
   */
  createErrorEvent(error: Error): RunErrorEvent {
    return {
      ...this.createBaseEvent('RUN_ERROR'),
      type: 'RUN_ERROR',
      error: error.message,
      thread_id: this.threadId,
      run_id: this.runId,
    };
  }

  /**
   * Create a messages snapshot from the current conversation state
   */
  createMessagesSnapshot(messages: any[]): MessagesSnapshotEvent {
    return {
      ...this.createBaseEvent('MESSAGES_SNAPSHOT'),
      type: 'MESSAGES_SNAPSHOT',
      messages,
    };
  }
}
