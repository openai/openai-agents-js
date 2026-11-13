import { z } from 'zod';
import assert from 'node:assert/strict';
import { Agent, telemetry, tool } from '../../../src';
import type { TraceEvent } from '../../../src/runtime/telemetry';
import { text, toolCall, withScriptedResponses } from '../../../src/testing';

async function main() {
  const withTool = process.argv.includes('--with-tool');
  const events: TraceEvent[] = [];
  const supplied = new Set<string>();
  const callbackIds: (string | undefined)[] = [];
  const localEcho = tool({
    name: 'local_echo',
    description: 'Return the fixture answer.',
    parameters: z.object({}),
    execute() {
      callbackIds.push(telemetry.getCurrentSpan()?.context.spanId);
      return 'fixture-tool-result';
    },
  });
  const traceId = '11'.repeat(16);
  await telemetry.configure({
    traceProcessors: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  telemetry.setTracingIdGenerator({
    generateTraceId: () => traceId,
    generateSpanId() {
      const id = (0xfeed000000000000n + BigInt(supplied.size + 1)).toString(16);
      supplied.add(id);
      return id;
    },
  });
  try {
    const responses = [
      ...(withTool
        ? [
            {
              items: [toolCall('local_echo', {}, { callId: 'call_1' })],
              responseId: 'resp_tool_admitted',
            },
          ]
        : []),
      { items: [text('Observed.')], responseId: 'resp_final_admitted' },
    ];
    await withScriptedResponses(responses, async (peer) => {
      await telemetry.withTrace(
        { name: 'id-policy.application', includeSensitiveData: true },
        async (root) => {
          assert.equal(root.context.traceId, traceId);
          assert(supplied.has(root.context.spanId));
          await telemetry.withSpan(
            { name: 'id-policy.application.child' },
            async (child) => {
              assert(supplied.has(child.context.spanId));
              await using session = await new Agent({
                instructions: 'Answer.',
                model: 'fixture',
                provider: peer.provider,
                tools: withTool ? [localEcho] : [],
              }).session();
              assert.equal(
                (await (await session.submit('Answer once.')).wait())
                  .finalOutput,
                'Observed.',
              );
            },
          );
        },
      );
      assert.equal(peer.requests.length, withTool ? 2 : 1);
      assert.equal(callbackIds.length, withTool ? 1 : 0);
    });
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const coreIds = new Set(
      events
        .filter(
          (event) =>
            event.name === 'receiving_stream' && event.trace_id === traceId,
        )
        .map((event) => event.span_id),
    );
    assert.equal(coreIds.size, withTool ? 2 : 1);
    assert([...coreIds].every((id) => !supplied.has(id)));
    const ended = events.filter(
      (event) => event.lifecycle === 'end' && event.trace_id === traceId,
    );
    const logicalResponses = ended.filter(
      (event) =>
        event.name === 'response' &&
        event.attributes['sdk.span.kind'] === 'model',
    );
    const byId = new Map(ended.map((event) => [event.span_id, event]));
    function descends(id: string, ancestor: string): boolean {
      const visited = new Set<string>();
      let parent = byId.get(id)?.parent_span_id;
      while (parent && !visited.has(parent)) {
        if (parent === ancestor) return true;
        visited.add(parent);
        parent = byId.get(parent)?.parent_span_id;
      }
      return false;
    }
    if (process.env.TRACE_RESPONSE_SPAN_FIXTURE_CONTROL !== '1') {
      assert.equal(
        logicalResponses.length,
        withTool ? 2 : 1,
        'missing native logical response span',
      );
      assert(logicalResponses.every((event) => supplied.has(event.span_id)));
      assert.deepEqual(
        logicalResponses
          .map((event) => event.attributes['sdk.response.id'])
          .sort(),
        (withTool
          ? ['resp_tool_admitted', 'resp_final_admitted']
          : ['resp_final_admitted']
        ).sort(),
      );
      for (const response of logicalResponses) {
        assert.equal(
          events.filter(
            (event) =>
              event.span_id === response.span_id && event.lifecycle === 'start',
          ).length,
          1,
        );
        assert.equal(
          events.filter(
            (event) =>
              event.span_id === response.span_id && event.lifecycle === 'end',
          ).length,
          1,
        );
      }
      for (const id of coreIds)
        assert(
          !logicalResponses.some((response) => descends(id, response.span_id)),
        );
      const transport = ended.filter(
        (event) => event.name === 'stream_request',
      );
      assert.equal(transport.length, withTool ? 2 : 1);
      for (const event of transport)
        assert.equal(
          logicalResponses.filter((response) =>
            descends(event.span_id, response.span_id),
          ).length,
          1,
        );
      for (const id of callbackIds) {
        assert(id);
        assert(
          !logicalResponses.some((response) => descends(id, response.span_id)),
          'tool callback inherited provider polling context',
        );
      }
    }

    console.log(
      JSON.stringify({
        fixture_control_only:
          process.env.TRACE_RESPONSE_SPAN_FIXTURE_CONTROL === '1',
        logical_response_ids: logicalResponses.map((event) => [
          event.span_id,
          event.attributes['sdk.response.id'],
        ]),
        supplied: [...supplied],
        core_ids: [...coreIds],
        core_trace_id: traceId,
        tool_callback_ids: callbackIds,
        tool_spans: events
          .filter(
            (event) =>
              event.trace_id === traceId && event.name.includes('tool'),
          )
          .filter(
            (event, index, all) =>
              all.findIndex((row) => row.span_id === event.span_id) === index,
          )
          .map((event) => [
            event.name,
            event.span_id,
            supplied.has(event.span_id),
          ]),
      }),
    );
  } finally {
    telemetry.setTracingIdGenerator();
    await telemetry.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
