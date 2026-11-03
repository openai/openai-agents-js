import assert from 'node:assert/strict';
import { createInterface } from 'node:readline/promises';
import {
  Agent,
  MemorySession,
  Runner,
  RunState,
  tool,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents/classic/testing';
import { parseSessionState } from '@openai/agents';
import { SDKRunner } from '@openai/agents/migration';
import { z } from 'zod';

/** Finish a held call on its original runtime before importing completed history. */
export async function runClassicHandover(
  decide: (call: {
    name: string;
    callId: string;
    arguments: string;
  }) => Promise<'approve' | 'reject'>,
) {
  let effects = 0;
  const originalTool = tool({
    name: 'record_approved',
    description: 'Record one explicitly approved application effect.',
    parameters: z.object({}),
    needsApproval: true,
    execute: () => {
      effects++;
      return 'recorded';
    },
  });
  const originalAgent = new Agent({
    name: 'Original classic owner',
    tools: [originalTool],
    model: new ScriptedModel([
      modelResponse([
        functionCall('record_approved', {}, { callId: 'original-held-call' }),
      ]),
      modelResponse([assistantMessage('Classic run settled.')]),
    ]),
  });
  const originalRunner = new Runner({ tracingDisabled: true });
  const session = new MemorySession();
  const pending = await originalRunner.run(
    originalAgent,
    'Record the effect.',
    {
      session,
    },
  );
  assert.equal(pending.interruptions.length, 1);
  assert.equal(effects, 0);
  const originalCall = pending.interruptions[0].rawItem;
  assert(originalCall.type === 'function_call');

  const nativeAgent = new Agent({
    name: 'Completed-history consumer',
    model: new ScriptedModel([
      modelResponder((call) => {
        assert.deepEqual(call.request.input, [
          ...completed,
          { type: 'message', role: 'user', content: 'Continue from here.' },
        ]);
        return [assistantMessage('Native continuation complete.')];
      }),
    ]),
  });
  // Deliberately probe the runtime boundary; RunState is not an adapter input.
  await assert.rejects(
    async () =>
      Reflect.apply(SDKRunner.run, SDKRunner, [
        nativeAgent,
        pending.state,
        {
          context: undefined,
          session,
        },
      ]),
    TypeError,
  );
  const serialized = pending.state.toString();
  assert.throws(() => parseSessionState(serialized));
  assert.equal(effects, 0);

  // Retain this exact Agent/tool graph and Runner configuration. The snapshot
  // does not serialize executable callbacks or establish cross-version support.
  const restored = await RunState.fromString(originalAgent, serialized);
  const interruption = restored.getInterruptions()[0];
  assert(interruption);
  const call = interruption.rawItem;
  assert(call.type === 'function_call');
  assert.equal(call.callId, originalCall.callId);
  assert.equal(call.name, originalCall.name);
  assert.equal(call.arguments, originalCall.arguments);
  const decision = await decide({
    name: call.name,
    callId: call.callId,
    arguments: call.arguments,
  });
  if (decision === 'approve') restored.approve(interruption);
  else restored.reject(interruption);
  const finished = await originalRunner.run(originalAgent, restored, {
    session,
  });
  assert.equal(finished.interruptions.length, 0);
  assert.equal(effects, decision === 'approve' ? 1 : 0);
  const completed = await session.getItems();

  // Unknown effects or uncertain writes require application reconciliation;
  // never replay them merely to manufacture a completed pair.
  const result = await SDKRunner.run(nativeAgent, 'Continue from here.', {
    context: undefined,
    session,
  });
  assert.equal(effects, decision === 'approve' ? 1 : 0);
  return { result, effects };
}

if (typeof require !== 'undefined' && require.main === module) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  runClassicHandover(async (call) => {
    const answer = await terminal.question(
      'Approve ' + call.name + ' (' + call.callId + ')? [y/N] ',
    );
    return answer.trim().toLowerCase() === 'y' ? 'approve' : 'reject';
  })
    .then(({ result, effects }) => console.log(result.finalOutput, { effects }))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => terminal.close());
}
