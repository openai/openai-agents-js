import assert from 'node:assert/strict';
import { Agent, telemetry } from '@openai/agents';
import { text, withScriptedResponses } from '@openai/agents/testing';
import { startTraceReceiver } from './native-telemetry';

/** Run in a fresh process; verify built-in export and custom route replacement. */
export async function inspectTraceProcessors() {
  await using receiver = await startTraceReceiver();
  const first: string[] = [];
  const second: string[] = [];
  const added = {
    onEvent(event: telemetry.TraceEvent) {
      assert(Object.isFrozen(event));
      second.push(event.trace_id);
    },
  };
  await telemetry.configure({
    traces: {
      kind: 'otlp-http',
      endpoint: receiver.endpoint,
      protocol: 'json',
    },
    traceProcessors: [
      {
        onEvent: (event) => {
          first.push(event.trace_id);
        },
      },
    ],
  });
  try {
    return await withScriptedResponses(
      [[text('first')], [text('added')], [text('replaced')]],
      async (peer) => {
        const agent = new Agent({
          instructions: 'Answer.',
          provider: peer.provider,
        });
        const run = async (name: string) => {
          let traceId = '';
          await telemetry.withTrace({ name }, async (trace) => {
            traceId = trace.context.traceId;
            assert.equal((await agent.run(name)).finalOutput, name);
          });
          const flush = await telemetry.forceFlush({ timeoutMs: 5000 });
          assert.equal(flush.status, 'success');
          assert.equal(flush.failedDeliveries, 0);
          assert.equal(flush.droppedRecords, 0);
          return traceId;
        };
        const initial = await run('first');
        assert(first.includes(initial));
        assert(!second.includes(initial));
        assert(JSON.stringify(receiver.batches).includes(initial));

        await telemetry.addTraceProcessor(added);
        const combined = await run('added');
        assert(first.includes(combined) && second.includes(combined));
        assert(JSON.stringify(receiver.batches).includes(combined));

        await telemetry.setTraceProcessors([added]);
        const replaced = await run('replaced');
        assert(!first.includes(replaced));
        assert(second.includes(replaced));
        assert(!JSON.stringify(receiver.batches).includes(replaced));
        return {
          initial,
          combined,
          replaced,
          firstEvents: first.length,
          secondEvents: second.length,
        };
      },
    );
  } finally {
    await telemetry.shutdown();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  inspectTraceProcessors().then(
    (summary) => console.log(JSON.stringify(summary)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
