import assert from 'node:assert/strict';
import { Agent, computerTool, telemetry, type Computer } from '../../../src';
import {
  computerCall,
  text,
  withScriptedResponses,
} from '../../../src/testing';
import type { JsonObject } from '../../../src/runtime/binding';

async function main() {
  const exported: unknown[] = [];
  await telemetry.configure({
    traceProcessors: [
      {
        onEvents(events) {
          exported.push(...events);
        },
      },
    ],
  });
  const calls: string[] = [];
  const unexpected = () => {
    throw new Error('Unexpected computer action');
  };
  const driver: Computer<{ account: string }> = {
    screenshot: () => {
      calls.push('screenshot');
      return 'aA==';
    },
    click: unexpected,
    doubleClick: unexpected,
    scroll: unexpected,
    type: unexpected,
    wait: unexpected,
    move: unexpected,
    keypress: unexpected,
    drag: unexpected,
  };
  const sidecar = { ticket: 'private-computer-ticket', nested: { value: 1 } };
  const pending = [{ id: 'check', code: 'domain', message: 'confirm' }];
  const rawValues: JsonObject[] = [];
  try {
    await withScriptedResponses(
      [
        [
          computerCall([{ type: 'screenshot' }], {
            callId: 'computer-data',
            pendingSafetyChecks: pending,
          }),
        ],
        [text('done')],
      ],
      async (peer) => {
        const session = await new Agent({
          instructions: 'Use the computer.',
          model: 'fixture',
          provider: peer.provider,
          tools: [
            computerTool<{ account: string }>({
              computer: {
                create: () => driver,
                dispose: () => {
                  calls.push('dispose');
                },
              },
              approve: () => {
                calls.push('approve');
                return true;
              },
              onSafetyCheck: () => {
                calls.push('safety');
                return true;
              },
              async extractApplicationData(context, raw) {
                assert.equal(context.callId, 'computer-data');
                assert.deepEqual(context.context, { account: 'synthetic' });
                assert.equal(context.signal.aborted, false);
                rawValues.push(structuredClone(raw));
                raw.call_id = 'mutated-call';
                (raw.output as JsonObject).image_url = 'private-raw-mutation';
                (raw.acknowledged_safety_checks as JsonObject[])[0].message =
                  'mutated';
                calls.push('extract');
                return sidecar;
              },
            }),
          ],
        }).session({
          context: { account: 'synthetic' },
          tracing: { name: 'computer-app-data', includeSensitiveData: true },
        });
        try {
          const result = await (await session.submit('Screenshot.')).wait();
          assert.equal(result.finalOutput, 'done');
          assert.equal(result.applicationToolOutputs?.length, 1);
          assert.equal(
            result.applicationToolOutputs?.[0]?.callId,
            'computer-data',
          );
          assert.deepEqual(
            result.applicationToolOutputs?.[0]?.applicationData,
            sidecar,
          );
          sidecar.nested.value = 99;
          assert.deepEqual(
            result.applicationToolOutputs?.[0]?.applicationData,
            {
              ticket: 'private-computer-ticket',
              nested: { value: 1 },
            },
          );
          assert.ok(
            !JSON.stringify(await Array.fromAsync(session.items())).includes(
              'private-computer-ticket',
            ),
          );
        } finally {
          await session.close();
        }
        const output = (peer.requests[1].input as JsonObject[]).find(
          (item) => item.type === 'computer_call_output',
        );
        assert.equal(output?.call_id, 'computer-data');
        assert.deepEqual(output?.output, {
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,aA==',
        });
        assert.deepEqual(output?.acknowledged_safety_checks, pending);
        assert.ok(
          !JSON.stringify(peer.requests).includes('private-computer-ticket'),
        );
        assert.ok(
          !JSON.stringify(peer.requests).includes('private-raw-mutation'),
        );
      },
    );
    assert.deepEqual(rawValues, [
      {
        type: 'computer_call_output',
        call_id: 'computer-data',
        output: {
          type: 'computer_screenshot',
          image_url: 'data:image/png;base64,aA==',
        },
        acknowledged_safety_checks: pending,
      },
    ]);
    assert.deepEqual(calls, [
      'approve',
      'safety',
      'screenshot',
      'extract',
      'dispose',
    ]);
  } finally {
    assert.equal((await telemetry.forceFlush()).status, 'success');
    await telemetry.shutdown();
  }
  assert.ok(exported.length > 0);
  assert.ok(!JSON.stringify(exported).includes('private-computer-ticket'));
  assert.ok(!JSON.stringify(exported).includes('private-raw-mutation'));
  console.log('PASS computer-application-data');
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
