import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Agent } from '@openai/agents';
import type {
  ResponseStreamEvent,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses';
import { askOrderAgent, orderRequest } from './agent';

export type Send = (event: Record<string, unknown>) => void;
export type ResponseEnvelope = {
  type: 'response.event';
  delegation_id: string;
  event: ResponseStreamEvent;
};

// Live forwards function items separately from the empty terminal output snapshot.
export class DelegationHandler {
  private responses = new Map<string, string>();
  private calls = new Map<string, Map<string, ResponseFunctionToolCall>>();
  private completed = new Set<string>();
  private seenCalls = new Set<string>();
  private worker: Promise<void> = Promise.resolve();
  private controller = new AbortController();

  constructor(
    private agent: Agent,
    private send: Send,
    private notify: Send,
    private onError: () => void,
  ) {}

  stop() {
    this.controller.abort();
  }

  async settled() {
    await this.worker;
  }

  receive(envelope: ResponseEnvelope) {
    if (this.controller.signal.aborted) return;
    const { delegation_id: delegationId, event } = envelope;
    if (event.type === 'response.created') {
      this.responses.set(delegationId, event.response.id);
      return;
    }
    const responseId = this.responses.get(delegationId);
    if (!responseId)
      throw new Error('Responses event arrived before response.created.');
    const key = JSON.stringify([delegationId, responseId]);
    if (
      event.type === 'response.output_item.done' &&
      event.item.type === 'function_call'
    ) {
      if (this.completed.has(key)) return;
      const calls = this.calls.get(key) ?? new Map();
      calls.set(event.item.call_id, event.item);
      this.calls.set(key, calls);
    } else if (event.type === 'response.completed') {
      const completedKey = JSON.stringify([delegationId, event.response.id]);
      if (this.completed.has(completedKey)) return;
      this.completed.add(completedKey);
      const calls = [...(this.calls.get(completedKey)?.values() ?? [])].filter(
        (call) => !this.seenCalls.has(call.call_id),
      );
      this.calls.delete(completedKey);
      for (const call of calls) this.seenCalls.add(call.call_id);
      if (!calls.length) return;
      this.worker = this.worker
        .then(async () => {
          const signal = this.controller.signal;
          for (const call of calls) {
            if (signal.aborted) return;
            this.notify({
              type: 'backend',
              status: 'working',
              call_id: call.call_id,
            });
            let request: z.infer<typeof orderRequest> | undefined;
            try {
              if (call.name !== 'ask_order_agent')
                throw new Error('Unknown function.');
              request = orderRequest.parse(JSON.parse(call.arguments));
            } catch {
              // Invalid model arguments do not reach the specialist.
            }
            let output =
              'Invalid specialist request. Supply a self-contained request.';
            if (request) {
              try {
                output = await askOrderAgent(
                  this.agent,
                  request.request,
                  signal,
                );
              } catch {
                // Do not expose exception payloads to the browser or the models.
                output = 'The order specialist failed. No order was changed.';
              }
            }
            if (signal.aborted) return;
            this.send({
              type: 'response.item.create',
              event_id: randomUUID(),
              item: {
                type: 'function_call_output',
                call_id: call.call_id,
                output,
              },
            });
            this.notify({
              type: 'backend',
              status: 'result_submitted',
              call_id: call.call_id,
              result: output,
            });
          }
          if (signal.aborted) return;
          this.send({ type: 'response.create', event_id: randomUUID() });
          this.notify({
            type: 'backend',
            status: 'continued',
            delegation_id: delegationId,
            response_id: event.response.id,
          });
        })
        .catch(() => {
          this.stop();
          this.onError();
        });
    } else if (
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    ) {
      throw new Error('The managed Responses backend did not complete.');
    }
  }
}
