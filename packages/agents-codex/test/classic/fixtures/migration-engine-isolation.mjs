import assert from 'node:assert/strict';
import console from 'node:console';
import { once } from 'node:events';
import * as classic from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  modelResponse,
} from '@openai/agents/classic/testing';
import * as realtime from '@openai/agents/classic/realtime';
import { ScriptedRealtimeTransport } from '@openai/agents/classic/realtime/testing';
import * as core from '@openai/agents-core';
import * as realtimeOwner from '@openai/agents-realtime';

classic.setTracingDisabled(true);
const original = {
  Agent: classic.Agent,
  Runner: classic.Runner,
  run: classic.run,
  runnerRun: classic.Runner.prototype.run,
  RealtimeAgent: realtime.RealtimeAgent,
  RealtimeSession: realtime.RealtimeSession,
};
const runner = new classic.Runner({ tracingDisabled: true });
const model = new ScriptedModel(
  ['before migration', 'existing runner', 'default runner'].map((text) =>
    modelResponse([assistantMessage(text)]),
  ),
);
const agent = new classic.Agent({ name: 'Classic owner', model });
assert.equal(
  (await runner.run(agent, 'baseline')).finalOutput,
  'before migration',
);

const { SDKRunner } = await import('@openai/agents/migration');

function assertOwners() {
  assert.equal(classic.Agent, original.Agent);
  assert.equal(classic.Agent, core.Agent);
  assert.equal(classic.Runner, original.Runner);
  assert.equal(classic.Runner, core.Runner);
  assert.equal(classic.run, original.run);
  assert.equal(classic.run, core.run);
  assert.equal(classic.Runner.prototype.run, original.runnerRun);
  assert.equal(realtime.RealtimeAgent, original.RealtimeAgent);
  assert.equal(realtime.RealtimeAgent, realtimeOwner.RealtimeAgent);
  assert.equal(classic.realtime.RealtimeAgent, original.RealtimeAgent);
  assert.equal(realtime.RealtimeSession, original.RealtimeSession);
  assert.equal(realtime.RealtimeSession, realtimeOwner.RealtimeSession);
  assert.equal(classic.realtime.RealtimeSession, original.RealtimeSession);
}

assertOwners();
const afterImport = await runner.run(agent, 'after import');
assert.equal(afterImport.finalOutput, 'existing runner');
assert.equal(afterImport.lastAgent, agent);
assert.equal(
  (await classic.run(agent, 'default dispatch')).finalOutput,
  'default runner',
);
assert.equal(model.calls.length, 3);
assert.ok(model.calls.every((call) => !call.streamed));

const transport = new ScriptedRealtimeTransport();
const session = new realtime.RealtimeSession(
  new realtime.RealtimeAgent({ name: 'Realtime owner' }),
  { transport, tracingDisabled: true },
);
assert.equal(session.transport, transport);
const inputAudio = new Uint8Array([1, 2, 3]).buffer;
const outputAudio = new Uint8Array([4, 5, 6]).buffer;
const stopListening = new globalThis.AbortController();
const receivedAudio = once(session, 'audio', { signal: stopListening.signal });
// Cleanup also settles this listener if the scenario fails before emitting audio.
void receivedAudio.catch(() => {});
let heardAudio;
try {
  await transport.runScenario({
    scenario: async ({ expectCall, emit }) => {
      await expectCall('connect', (call) => {
        assert.equal(call.options.apiKeyProvided, true);
        assert.equal(Object.hasOwn(call.options, 'apiKey'), false);
        assert.ok(call.options.initialSessionConfig);
      });
      await expectCall('sendMessage', (call) => {
        assert.equal(call.message, 'Hello');
        assert.deepEqual(call.otherEventData, {
          source: 'migration-isolation',
        });
      });
      await expectCall('sendAudio', (call) => {
        assert.deepEqual(new Uint8Array(call.audio), new Uint8Array([1, 2, 3]));
        assert.deepEqual(call.options, { commit: true });
      });
      emit('audio', {
        type: 'audio',
        data: outputAudio,
        responseId: 'audio_1',
      });
      await expectCall('close');
    },
    exercise: async () => {
      try {
        await session.connect({ apiKey: 'synthetic-test-key' });
        session.sendMessage('Hello', { source: 'migration-isolation' });
        session.sendAudio(inputAudio, { commit: true });
        [heardAudio] = await receivedAudio;
        assert.equal(heardAudio.type, 'audio');
        assert.equal(heardAudio.responseId, 'audio_1');
        assert.deepEqual(
          new Uint8Array(heardAudio.data),
          new Uint8Array([4, 5, 6]),
        );
      } finally {
        session.close();
      }
    },
  });
} finally {
  stopListening.abort();
  session.close();
}
assert.deepEqual(
  transport.calls.map((call) => call.method),
  ['connect', 'sendMessage', 'sendAudio', 'close'],
);
transport.assertComplete();
transport.assertClosed();

let instructionCalls = 0;
let providerCalls = 0;
const refusalModel = new ScriptedModel([
  modelResponse([assistantMessage('explicit classic choice')]),
]);
const unsupported = new classic.Agent({
  name: 'Dynamic classic agent',
  model: 'owned-model',
  modelSettings: {},
  instructions: () => {
    instructionCalls += 1;
    return 'Dynamic instructions remain supported by classic.';
  },
});
const provider = {
  getModel(name) {
    providerCalls += 1;
    assert.equal(name, 'owned-model');
    return refusalModel;
  },
};
const supportedInstructions = unsupported.instructions;
// Dynamic callbacks are supported; invalid JavaScript declarations still refuse.
unsupported.instructions = 42;
await assert.rejects(
  SDKRunner.run(unsupported, 'refuse', {
    context: undefined,
    modelProvider: provider,
  }),
  (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /string or callable instructions/);
    assert.match(error.message, /use @openai\/agents\/classic/);
    return true;
  },
);
assert.equal(instructionCalls, 0);
assert.equal(providerCalls, 0);
assert.equal(refusalModel.calls.length, 0);
assertOwners();
unsupported.instructions = supportedInstructions;
const explicitClassic = await new classic.Runner({
  tracingDisabled: true,
  modelProvider: provider,
}).run(unsupported, 'explicit classic');
assert.equal(explicitClassic.finalOutput, 'explicit classic choice');
assert.equal(explicitClassic.lastAgent, unsupported);
assert.equal(instructionCalls, 1);
assert.equal(providerCalls, 1);
assert.equal(refusalModel.calls.length, 1);
assertOwners();
assert.ok(
  globalThis.classicPackageObservation,
  'The import guard must preload.',
);
assert.deepEqual(globalThis.classicPackageObservation.processCalls, []);
console.log(
  JSON.stringify({
    fixture: 'migration-engine-isolation',
    completed: true,
    classicModelCalls: model.calls.length,
    realtimeCalls: transport.calls.map((call) => call.method),
    audioBytes: Array.from(new Uint8Array(heardAudio.data)),
    refusedBeforeClassic: true,
    explicitClassicModelCalls: refusalModel.calls.length,
    processCalls: globalThis.classicPackageObservation.processCalls.length,
  }),
);
