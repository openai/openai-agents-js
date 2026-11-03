import console from 'node:console';
import assert from 'node:assert/strict';

export async function checkMixedImports(load, order) {
  let native;
  let classic;
  if (order === 'native-first') {
    native = await load('@openai/agents');
    assert.equal(
      globalThis.classicPackageObservation.resolved.some((url) =>
        /\/@openai\/agents-(core|openai|realtime)\//.test(url),
      ),
      false,
      'Native-only import must not load classic provider or tracing modules.',
    );
    classic = await load('@openai/agents/classic');
  } else {
    classic = await load('@openai/agents/classic');
  }
  const { ScriptedModel, assistantMessage, modelResponse } = await load(
    '@openai/agents/classic/testing',
  );
  const selectedNames = [];
  const model = new ScriptedModel([
    modelResponse([assistantMessage('selected provider')]),
  ]);
  classic.setDefaultModelProvider({
    getModel(name) {
      selectedNames.push(name);
      return model;
    },
  });
  const traces = [];
  classic.setTraceProcessors([
    {
      async onTraceStart() {
        traces.push('start');
      },
      async onTraceEnd() {
        traces.push('end');
      },
      async onSpanStart() {},
      async onSpanEnd() {},
      async shutdown() {},
      async forceFlush() {},
    },
  ]);
  classic.setTracingDisabled(false);
  const traceProvider = classic.getGlobalTraceProvider();
  if (order === 'classic-first') native = await load('@openai/agents');
  assert.notEqual(native.Agent, classic.Agent);
  assert.equal(classic.Agent, (await load('@openai/agents-core')).Agent);
  assert.equal(
    classic.OpenAIProvider,
    (await load('@openai/agents-openai')).OpenAIProvider,
  );
  assert.equal(
    classic.realtime.RealtimeAgent,
    (await load('@openai/agents-realtime')).RealtimeAgent,
  );
  assert.equal(classic.getGlobalTraceProvider(), traceProvider);
  await classic.withTrace('mixed import', async () => {});
  assert.deepEqual(traces, ['start', 'end']);
  const result = await new classic.Runner({
    model: 'owned-model',
    tracingDisabled: true,
  }).run(new classic.Agent({ name: 'classic' }), 'input');
  assert.equal(result.finalOutput, 'selected provider');
  assert.deepEqual(selectedNames, ['owned-model']);
  assert.deepEqual(globalThis.classicPackageObservation.processCalls, []);
  console.log('Mixed imports passed: ' + order);
}

export async function checkConditions(load, resolve, condition, extension) {
  const corePath = resolve('@openai/agents-core/_shims');
  const realtimePath = resolve('@openai/agents-realtime/_shims');
  const configPath = resolve('@openai/agents-core/_shims/config');
  assert.ok(
    corePath.endsWith(`/shims/shims-${condition}.${extension}`),
    corePath,
  );
  assert.ok(
    realtimePath.endsWith(`/shims/shims-${condition}.${extension}`),
    realtimePath,
  );
  const config = condition === 'react-native' ? 'browser' : condition;
  assert.ok(
    configPath.endsWith(`/shims/config-${config}.${extension}`),
    configPath,
  );
  const core = await load('@openai/agents-core/_shims');
  const realtime = await load('@openai/agents-realtime/_shims');
  assert.equal(core.supportsProcessLifecycleEvents(), condition === 'node');
  assert.equal(core.isTracingLoopRunningByDefault(), condition === 'node');
  assert.equal(
    realtime.isBrowserEnvironment(),
    condition === 'browser' || condition === 'react-native',
  );
  assert.equal(realtime.useWebSocketProtocols, condition !== 'node');
  assert.equal(typeof core.RuntimeEventEmitter, 'function');
  if (condition !== 'node')
    assert.equal(realtime.WebSocket, globalThis.WebSocket);
  console.log(`Conditional shims passed: ${condition} ${extension}`);
}
