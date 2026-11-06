import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type LiveMessage = { type: string; [key: string]: unknown };
export type Send = (message: LiveMessage) => Promise<void>;

export const specialistRequest = z.strictObject({
  request: z
    .string()
    .min(1)
    .describe(
      'A self-contained request including the order ID and latest corrections.',
    ),
});

const envelopeSchema = z.object({
  type: z.literal('response.event'),
  delegation_id: z.string().min(1),
  event: z.looseObject({ type: z.string() }),
});
const responseSchema = z.object({
  response: z.object({ id: z.string().min(1) }),
});
const itemSchema = z.object({ item: z.looseObject({ type: z.string() }) });
const callSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string().min(1),
  name: z.string(),
  arguments: z.string(),
});
type FunctionCall = z.infer<typeof callSchema>;

/** Collect completed calls while the connection continues receiving events. */
export function createDelegationHandler(options: {
  signal: AbortSignal;
  runAgent: (request: string, signal: AbortSignal) => Promise<string>;
  send: Send;
  notify: Send;
}) {
  const responses = new Map<string, string>();
  const calls = new Map<string, Map<string, FunctionCall>>();
  const completed = new Set<string>();
  const seenCalls = new Set<string>();
  let work = Promise.resolve();

  async function runBatch(
    delegationId: string,
    responseId: string,
    pending: FunctionCall[],
  ) {
    for (const call of pending) {
      options.signal.throwIfAborted();
      await options.notify({
        type: 'backend',
        status: 'working',
        call_id: call.call_id,
      });
      options.signal.throwIfAborted();
      let output =
        'Invalid specialist request. Supply a self-contained request.';
      let request: z.infer<typeof specialistRequest> | undefined;
      if (call.name === 'ask_order_agent') {
        try {
          request = specialistRequest.parse(JSON.parse(call.arguments));
        } catch {
          // Invalid arguments become a function result, without exposing their contents.
        }
      }
      if (request) {
        try {
          output = await options.runAgent(request.request, options.signal);
        } catch {
          options.signal.throwIfAborted();
          output = 'The order specialist failed. No order was changed.';
        }
      }
      options.signal.throwIfAborted();
      await options.send({
        type: 'response.item.create',
        event_id: randomUUID(),
        item: { type: 'function_call_output', call_id: call.call_id, output },
      });
      await options.notify({
        type: 'backend',
        status: 'result_submitted',
        call_id: call.call_id,
        result: output,
      });
    }
    options.signal.throwIfAborted();
    await options.send({ type: 'response.create', event_id: randomUUID() });
    await options.notify({
      type: 'backend',
      status: 'continued',
      delegation_id: delegationId,
      response_id: responseId,
    });
  }

  return {
    /** The caller observes returned work failures but never blocks the receiver on them. */
    receive(message: LiveMessage): Promise<void> | undefined {
      if (message.type !== 'response.event') return;
      options.signal.throwIfAborted();
      const { delegation_id: delegationId, event } =
        envelopeSchema.parse(message);
      if (event.type === 'response.created') {
        responses.set(delegationId, responseSchema.parse(event).response.id);
        return;
      }
      const currentResponse = responses.get(delegationId);
      if (!currentResponse)
        throw new Error('Received a Responses event before response.created.');
      const key = JSON.stringify([delegationId, currentResponse]);
      if (event.type === 'response.output_item.done') {
        const item = itemSchema.parse(event).item;
        if (item.type === 'function_call' && !completed.has(key)) {
          const call = callSchema.parse(item);
          const batch = calls.get(key) ?? new Map<string, FunctionCall>();
          batch.set(call.call_id, call);
          calls.set(key, batch);
        }
      } else if (event.type === 'response.completed') {
        const responseId = responseSchema.parse(event).response.id;
        const completedKey = JSON.stringify([delegationId, responseId]);
        if (completed.has(completedKey)) return;
        completed.add(completedKey);
        const pending = [...(calls.get(completedKey)?.values() ?? [])].filter(
          (call) => !seenCalls.has(call.call_id),
        );
        calls.delete(completedKey);
        for (const call of pending) seenCalls.add(call.call_id);
        if (pending.length) {
          work = work.then(() => runBatch(delegationId, responseId, pending));
          return work;
        }
      } else if (
        event.type === 'response.failed' ||
        event.type === 'response.incomplete'
      ) {
        const responseId = responseSchema.parse(event).response.id;
        calls.delete(JSON.stringify([delegationId, responseId]));
        throw new Error('The managed Responses backend did not complete.');
      }
    },
    /** Join every admitted batch, including a callback already entered at cancellation. */
    drain: () => work,
  };
}
