import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, NativeProvider, telemetry } from '@openai/agents-codex';
import type { TraceEvent } from '../../../src/runtime/telemetry';
import { nativeCodexTool } from '../../../../agents-extensions/src/experimental/codex';
import { ModelServer, call, message } from './model-server';

export async function runNativeCliTracingCase(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'native-cli-tracing-'));
  const events: TraceEvent[] = [];
  await telemetry.configure({
    toolResultMaxBytes: 4096,
    traceProcessors: [
      {
        onEvent(event) {
          events.push(event);
        },
      },
    ],
  });
  const item = (id: string, status: string) => ({
    id,
    type: 'command_execution',
    command:
      mode === 'oversized-unicode'
        ? 'PRIVATE_COMMAND🙂'.repeat(1200)
        : 'PRIVATE_COMMAND',
    aggregated_output:
      mode === 'oversized-unicode'
        ? 'PRIVATE_OUTPUT🙂'.repeat(1200)
        : 'PRIVATE_OUTPUT'.repeat(1000),
    status:
      mode === 'malformed-status'
        ? 'PRIVATE_STATUS🙂'.repeat(1200)
        : mode === 'oversized-unicode' && status === 'completed'
          ? 'failed'
          : status,
    exit_code: status === 'completed' ? 0 : null,
  });
  const sequence = [
    { type: 'thread.started', thread_id: 'synthetic-thread' },
    { type: 'item.started', item: item('a', 'in_progress') },
    { type: 'item.started', item: item('b', 'in_progress') },
    { type: 'item.completed', item: item('a', 'completed') },
    { type: 'item.completed', item: item('b', 'completed') },
    {
      type: 'item.completed',
      item: { id: 'message', type: 'agent_message', text: 'CLI completed' },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 },
    },
  ];
  if (mode === 'oversized-unicode') {
    const file = {
      id: 'file',
      type: 'file_change',
      status: 'failed',
      changes: Array.from({ length: 200 }, (_, index) => ({
        path: '🙂'.repeat(200) + index,
        kind: 'add',
      })),
    };
    sequence.splice(
      3,
      0,
      { type: 'item.started', item: file } as never,
      { type: 'item.completed', item: file } as never,
    );
  }
  if (mode === 'failed')
    sequence.splice(3, sequence.length, {
      type: 'turn.failed',
      error: { message: 'synthetic failure' },
    } as never);
  const cli = join(root, 'codex.mjs');
  await writeFile(
    cli,
    `#!${process.execPath}\nfor await (const chunk of process.stdin) {}\nfor (const event of ${JSON.stringify(sequence)}) console.log(JSON.stringify(event));\n`,
  );
  await chmod(cli, 0o700);
  const server = new ModelServer([
    [call('codex', { prompt: 'Run', threadId: null }, { callId: 'trace-cli' })],
    [message('done')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const observed: unknown[] = [];
    const declaration = nativeCodexTool({
      onEvent(event) {
        observed.push({ type: event.type, span: !!telemetry.getCurrentSpan() });
      },
      codexOptions: { codexPathOverride: cli },
    });
    await telemetry.withTrace(
      {
        name: 'CLI parent',
        disabled: mode === 'disabled',
        includeSensitiveData: mode !== 'metadata',
      },
      async () => {
        const agent = new Agent({
          instructions: 'Use codex.',
          model: 'gpt-5',
          provider,
          tools: [declaration],
        });
        if (mode === 'failed')
          await assert.rejects(agent.run('Run'), /synthetic failure/);
        else assert.equal((await agent.run('Run')).finalOutput, 'done');
      },
    );
    assert.equal((await telemetry.forceFlush()).status, 'success');
    const commandEvents = events.filter(
      (event) => event.name === 'Codex command execution',
    );
    if (mode === 'disabled') assert.equal(commandEvents.length, 0);
    else {
      const ended = commandEvents.filter((event) => event.lifecycle === 'end');
      assert.equal(
        ended.length,
        2,
        JSON.stringify({
          observed,
          names: events.map((e) => ({ name: e.name, lifecycle: e.lifecycle })),
        }),
      );
      assert.equal(new Set(ended.map((event) => event.parent_span_id)).size, 1);
      assert.equal(new Set(ended.map((event) => event.span_id)).size, 2);
      if (mode === 'oversized-unicode' || mode === 'malformed-status') {
        const items = events.filter(
          (event) =>
            event.lifecycle === 'end' &&
            (event.name === 'Codex command execution' ||
              event.name === 'Codex file change'),
        );
        assert.equal(items.length, mode === 'oversized-unicode' ? 3 : 2);
        for (const event of items) {
          assert.equal(
            event.outcome,
            mode === 'oversized-unicode' ? 'error' : 'ok',
          );
          assert.notEqual(
            event.attributes['sdk.outcome.category'],
            'trace_end_error',
          );
          const data = event.attributes['sdk.outcome.data'];
          assert.equal(typeof data, 'string');
          assert(Buffer.byteLength(data as string, 'utf8') <= 4096);
          const status = JSON.parse(data as string).status;
          if (mode === 'oversized-unicode') assert.equal(status, 'failed');
          else {
            assert(status.startsWith('PRIVATE_STATUS'));
            assert(Buffer.byteLength(status, 'utf8') <= 256);
          }
        }
      }
      const data = JSON.stringify(commandEvents);
      if (mode !== 'malformed-status')
        assert.equal(data.includes('PRIVATE_COMMAND'), mode !== 'metadata');
      if (mode !== 'oversized-unicode' && mode !== 'malformed-status')
        assert.equal(data.includes('PRIVATE_OUTPUT'), mode !== 'metadata');
    }
  } finally {
    ModelServer.closeAll();
    await telemetry.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2])
  void runNativeCliTracingCase(process.argv[2])
    .then(() => console.log(`PASS ${process.argv[2]}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
