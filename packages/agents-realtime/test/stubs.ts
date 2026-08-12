import { protocol, tool } from '@openai/agents-core';
import { RuntimeEventEmitter } from '@openai/agents-core/_shims';
import { assistantMessage } from '@openai/agents-core/testing';
import { EventEmitterDelegate } from '@openai/agents-core/utils';
import { z } from 'zod';
import type {
  RealtimeClientMessage,
  RealtimeSessionConfig,
  RealtimeUserInput,
} from '../src/clientMessages';
import type { RealtimeItem } from '../src/items';
import type {
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
} from '../src/transportLayer';
import type { TransportToolCallEvent } from '../src/transportLayerEvents';
import { RealtimeTransportEventTypes } from '../src/transportLayerEvents';

const TEST_MODEL_MESSAGE: protocol.AssistantMessageItem = assistantMessage(
  'Hello World',
  { id: '123' },
);

export function fakeModelMessage(text: string): protocol.AssistantMessageItem {
  return assistantMessage(text, { id: TEST_MODEL_MESSAGE.id });
}

export const TEST_TOOL = tool({
  name: 'test',
  description: 'Test tool',
  parameters: z.object({
    test: z.string(),
  }),
  execute: async (_input: any) => {
    return 'Hello World';
  },
});

export class FakeTransport
  extends EventEmitterDelegate<RealtimeTransportEventTypes>
  implements RealtimeTransportLayer
{
  #functionCallOutputWaiters: Array<{
    count: number;
    resolve: (call: [TransportToolCallEvent, string, boolean]) => void;
  }> = [];
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'disconnected';
  muted: boolean = false;
  connectCalls: RealtimeTransportLayerConnectOptions[] = [];
  sendEventCalls: RealtimeClientMessage[] = [];
  sendMessageCalls: [RealtimeUserInput, Record<string, any>][] = [];
  sendAudioCalls: [ArrayBuffer, { commit?: boolean }][] = [];
  updateSessionConfigCalls: Partial<RealtimeSessionConfig>[] = [];
  addImageCalls: [string, { triggerResponse?: boolean } | undefined][] = [];
  closeCalls = 0;
  eventEmitter = new RuntimeEventEmitter<RealtimeTransportEventTypes>();
  muteCalls: boolean[] = [];
  sendFunctionCallOutputCalls: [TransportToolCallEvent, string, boolean][] = [];
  sendMcpResponseCalls: [any, boolean, string | undefined][] = [];
  interruptCalls = 0;
  resetHistoryCalls: [RealtimeItem[], RealtimeItem[]][] = [];

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    this.connectCalls.push(options);
  }

  sendEvent(event: RealtimeClientMessage): void {
    this.sendEventCalls.push(event);
  }

  sendMessage(
    message: RealtimeUserInput,
    otherEventData: Record<string, any>,
    _options?: { triggerResponse?: boolean },
  ): void {
    this.sendMessageCalls.push([message, otherEventData]);
  }

  addImage(image: string, options?: { triggerResponse?: boolean }): void {
    this.addImageCalls.push([image, options]);
  }

  sendAudio(audio: ArrayBuffer, options: { commit?: boolean }): void {
    this.sendAudioCalls.push([audio, options]);
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    this.updateSessionConfigCalls.push(config);
  }

  close(): void {
    this.closeCalls += 1;
  }

  mute(muted: boolean): void {
    this.muted = muted;
    this.muteCalls.push(muted);
  }

  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean,
  ): void {
    const call: [TransportToolCallEvent, string, boolean] = [
      toolCall,
      output,
      startResponse,
    ];
    this.sendFunctionCallOutputCalls.push(call);
    const ready = this.#functionCallOutputWaiters.filter(
      (waiter) => this.sendFunctionCallOutputCalls.length >= waiter.count,
    );
    this.#functionCallOutputWaiters = this.#functionCallOutputWaiters.filter(
      (waiter) => this.sendFunctionCallOutputCalls.length < waiter.count,
    );
    for (const waiter of ready) {
      waiter.resolve(this.sendFunctionCallOutputCalls[waiter.count - 1]!);
    }
  }

  waitForNextFunctionCallOutput(): Promise<
    [TransportToolCallEvent, string, boolean]
  > {
    const count = this.sendFunctionCallOutputCalls.length + 1;
    return new Promise((resolve) => {
      this.#functionCallOutputWaiters.push({ count, resolve });
    });
  }

  sendMcpResponse(
    approvalRequest: any,
    approved: boolean,
    reason?: string,
  ): void {
    this.sendMcpResponseCalls.push([approvalRequest, approved, reason]);
  }

  interrupt(): void {
    this.interruptCalls += 1;
  }

  resetHistory(oldHistory: RealtimeItem[], newHistory: RealtimeItem[]): void {
    this.resetHistoryCalls.push([oldHistory, newHistory]);
  }
}
