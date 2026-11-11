import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { ModelServer, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
it.each(['completed', 'turn'] as const)(
  'retains all logical-root guardrail records in %s',
  async (projection) => {
    const native = await binding();
    const next = native.NativeThread.prototype._next_session_events;
    const submit = native.NativeThread.prototype._submit;
    let projected = false;
    const admitting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await next.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        !projected &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        projected = true;
        event.sdk_unsampled_steering = true;
        return replaceSingletonNativeBatchEvent(raw, event);
      }
      return raw;
    });
    // Only the conditional idle hint/admission has been projecting; all model turns and guards have been executing natively.
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        const request = JSON.parse(raw);
        if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
        admitting.resolve();
        await release.promise;
        return submit.call(
          this,
          JSON.stringify({
            mode: 'start_if_idle',
            input: [{ type: 'text', text: 'continued input' }],
            start: request.start,
          }),
        );
      },
    );
    const server = new ModelServer([
      [message('first')],
      [message('continued')],
      [message('unrelated')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-guards',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      inputGuardrails: [
        {
          name: 'root-input',
          runInParallel: false,
          callback() {
            return { tripwireTriggered: false };
          },
        },
      ],
      outputGuardrails: [
        {
          name: 'accepted-output',
          callback(request) {
            return {
              tripwireTriggered: false,
              outputInfo: request.finalOutput,
            };
          },
        },
      ],
    }).session();
    try {
      const turn = await session.submit('initial');
      await admitting.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      release.resolve();
      const completed = await turn.wait();
      expect(completed.finalOutput).toBe('continued');
      const records =
        projection === 'completed'
          ? completed.guardrailResults
          : turn.guardrailResults;
      expect(records?.map((record) => record.name)).toEqual([
        'root-input',
        'accepted-output',
        'accepted-output',
      ]);
      expect(
        records
          ?.filter((record) => record.kind === 'output')
          .map((record) => record.result.outputInfo),
      ).toEqual(['first', 'continued']);
      expect(turn.guardrailResults).toEqual(completed.guardrailResults);
      const fresh = await session.submit('unrelated');
      expect(
        (await fresh.wait()).guardrailResults?.map((record) => record.name),
      ).toEqual(['root-input', 'accepted-output']);
      expect(turn.guardrailResults).toEqual(records);
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  },
  20000,
);
