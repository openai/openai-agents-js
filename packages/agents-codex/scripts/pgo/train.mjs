import assert from 'node:assert/strict';
import process from 'node:process';
import { setImmediate } from 'node:timers';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import {
  isMainThread,
  Worker,
  workerData,
  parentPort,
} from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'));
const hash = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

async function train(family, entry, addonSha, baseUrl) {
  const require = createRequire(pathToFileURL(entry));
  const addon = realpathSync(
    join(
      dirname(require.resolve('@openai/agents-codex')),
      '../native/codex.node',
    ),
  );
  assert.equal(hash(addon), addonSha);
  const sdk = await import(pathToFileURL(entry));
  const { z } = require('zod');
  const spec = corpus.cases.find((item) => item.family === family);
  const shape = z.object({
    manifest: z.object({ label: z.string(), codes: z.array(z.number().int()) }),
    ready: z.boolean(),
  });
  const primary = new Error('pgo-tool-expected');
  let toolExecutions = 0,
    providers = 0,
    agents = 0,
    providerCloses = 0,
    explicitRuntimes = 0,
    runtimeCloses = 0,
    successes = 0,
    rejections = 0;
  const sessions = new Set();
  const tools =
    family === 'tools-errors'
      ? [
          sdk.tool({
            name: 'echo',
            description: 'Return the supplied cargo label.',
            parameters: z.object({ value: z.string() }),
            execute: async ({ value }) => {
              toolExecutions++;
              if (value.includes('pgo_tool_error')) throw primary;
              return value;
            },
          }),
        ]
      : [];
  const create = (runtime) => {
    providers++;
    const provider = new sdk.NativeProvider({
      baseUrl,
      apiKey: 'pgo-training-synthetic',
      supportsWebsockets: false,
      ...(runtime ? { runtime } : {}),
    });
    agents++;
    const agent = new sdk.Agent({
      name: 'Cargo training',
      instructions: 'Inspect the cargo manifest; use echo when requested.',
      model: 'gpt-5',
      modelSettings: { reasoningEffort: 'low' },
      tools,
      provider,
      ...(family === 'structured-output' ? { outputType: shape } : {}),
    });
    return { provider, agent };
  };
  const check = (result, turn) => {
    assert.deepEqual(result.finalOutput, turn.expectedOutput);
    assert.equal(typeof result.turn.sessionId, 'string');
    sessions.add(result.turn.sessionId);
    successes++;
  };
  const stats = async () => {
    const response = await globalThis.fetch(`${baseUrl}/stats`);
    assert(response.ok);
    return response.json();
  };
  if (family === 'cold-fresh') {
    const runtime = new sdk.NativeRuntime();
    explicitRuntimes++;
    try {
      const first = create(runtime);
      try {
        for (const item of spec.turns.slice(0, 2))
          check(await first.agent.run(item.input), item);
      } finally {
        await first.provider.close();
        providerCloses++;
      }
      const second = create(runtime);
      try {
        check(await second.agent.run(spec.turns[2].input), spec.turns[2]);
      } finally {
        await second.provider.close();
        providerCloses++;
      }
      assert.equal(sessions.size, 3);
    } finally {
      await runtime.close();
      runtimeCloses++;
    }
  } else {
    const { provider, agent } = create();
    try {
      if (family === 'retained-history' || family === 'streaming') {
        const session = await agent.session();
        try {
          let cursor = 0;
          for (const item of spec.turns) {
            const turn = await session.submit(item.input, { ifBusy: 'reject' });
            if (family === 'streaming') {
              let text = '',
                deltas = 0;
              for await (const event of turn.events({ after: cursor })) {
                assert.notEqual(event.type, 'gap');
                cursor = event.sequence;
                if (event.type === 'output_text_delta') {
                  text += event.delta;
                  deltas++;
                }
              }
              assert(deltas > 0);
              assert.equal(text, item.expectedOutput);
            }
            check(await turn.wait(), item);
          }
          assert.equal(sessions.size, 1);
        } finally {
          await session.close();
        }
      } else if (family === 'tools-errors') {
        check(await agent.run(spec.turns[0].input), spec.turns[0]);
        await assert.rejects(
          agent.run(spec.turns[1].input),
          (error) => error === primary,
        );
        rejections++;
        assert.equal(toolExecutions, 4);
      } else if (family === 'cancellation') {
        const controller = new globalThis.AbortController(),
          reason = new Error('pgo-observed-request-stop');
        const pending = agent
          .run(spec.turns[0].input, { signal: controller.signal })
          .then(
            () => {
              throw new Error('Expected cancellation');
            },
            (error) => error,
          );
        while ((await stats()).heldRequests !== 1)
          await new Promise(setImmediate);
        controller.abort(reason);
        assert.equal(await pending, reason);
        rejections++;
        while ((await stats()).abortedRequests !== 1)
          await new Promise(setImmediate);
        check(await agent.run(spec.turns[1].input), spec.turns[1]);
      } else if (family === 'concurrency') {
        await Promise.all(
          spec.turns.map(async (item) =>
            check(await agent.run(item.input), item),
          ),
        );
        assert.equal(sessions.size, 4);
      } else {
        assert.equal(family, 'structured-output');
        for (const item of spec.turns) check(await agent.run(item.input), item);
      }
    } finally {
      await provider.close();
      providerCloses++;
    }
  }
  assert.equal(successes, spec.successes);
  assert.equal(rejections, spec.controlledRejections);
  assert.equal(providers, spec.providers);
  assert.equal(agents, providers);
  assert.equal(providerCloses, providers);
  assert.equal(explicitRuntimes, spec.explicitRuntimes ?? 0);
  assert.equal(runtimeCloses, explicitRuntimes);
  assert.equal(toolExecutions, family === 'tools-errors' ? 4 : 0);
  assert(
    process.report
      .getReport()
      .sharedObjects.some(
        (path) => path.endsWith('.node') && realpathSync(path) === addon,
      ),
  );
  return {
    status: 'passed',
    family,
    pid: process.pid,
    addon,
    addonSha256: hash(addon),
    successes,
    rejections,
    providers,
    agents,
    providerCloses,
    explicitRuntimes,
    runtimeCloses,
    toolExecutions,
    publicSessionIds: [...sessions],
  };
}

if (!isMainThread) {
  parentPort.postMessage(
    await train(
      workerData.family,
      workerData.entry,
      workerData.addonSha,
      workerData.baseUrl,
    ),
  );
} else {
  const [family, entry, addonSha, output] = process.argv.slice(2);
  const spec = corpus.cases.find((item) => item.family === family);
  assert(spec);
  const fixtureEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('LLVM_') && !key.startsWith('BENCH_'),
    ),
  );
  Object.assign(fixtureEnv, {
    BENCH_OUTPUT_BYTES: '173',
    BENCH_STREAM_CHUNKS: '5',
  });
  const fixture = fork(join(here, 'fixture.mjs'), [], {
    env: fixtureEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '',
    stderr = '';
  fixture.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  fixture.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const fixtureExit = once(fixture, 'close');
  try {
    const [ready] = await once(fixture, 'message');
    assert.equal(ready.protocol, undefined);
    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const reset = await globalThis.fetch(
      `${baseUrl}/reset?oneShot=${!['retained-history', 'streaming'].includes(family)}&chain=${family === 'tools-errors'}`,
    );
    assert(reset.ok);
    await reset.text();
    let result;
    if (family === 'concurrency') {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { family, entry, addonSha, baseUrl },
      });
      const exited = once(worker, 'exit');
      [result] = await once(worker, 'message');
      const [code] = await exited;
      assert.equal(code, 0);
      result.workerNaturalExit = true;
    } else result = await train(family, entry, addonSha, baseUrl);
    const response = await globalThis.fetch(`${baseUrl}/stats`);
    const stats = await response.json();
    assert.equal(stats.requests, spec.requests);
    assert.equal(stats.errors, 0);
    assert.deepEqual(stats.failures, []);
    assert.equal(stats.heldRequests, family === 'cancellation' ? 1 : 0);
    assert.equal(stats.abortedRequests, family === 'cancellation' ? 1 : 0);
    fixture.send('close');
    const [code, signal] = await fixtureExit;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    writeFileSync(
      output,
      JSON.stringify(
        {
          ...result,
          fixtureStats: stats,
          fixtureJoined: true,
          exitProof:
            'Owner must observe this process natural exit0; summary alone is not flush proof.',
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    if (fixture.connected) {
      fixture.send('close');
      await fixtureExit;
    }
  }
}
// Deliberately no process.exit, interval or keepalive. Native profile flush is checked after owned natural process exit.
