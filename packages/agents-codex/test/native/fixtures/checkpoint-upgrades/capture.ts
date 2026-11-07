/** Capture original public checkpoint bytes with an immutable producer checkout.
 * Run through that checkout's Vitest aliases and matching verified native addon.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { it, expect } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, manualTool, tool } from '@openai/agents';
import { ModelServer, call, message } from '../model-server';

const digest = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

it('captures synthetic checkpoints with the specified producer', async () => {
  const source = process.env.CHECKPOINT_PRODUCER_SOURCE!;
  const output = process.env.CHECKPOINT_CAPTURE_OUTPUT!;
  if (!source || !output)
    throw new Error('Explicit producer and output are required');
  execFileSync(
    'git',
    [
      'diff',
      '--quiet',
      'HEAD',
      '--',
      'packages/agents-codex/src',
      'packages/agents-codex/native/rust',
    ],
    { cwd: source },
  );
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
  }).trim();
  await mkdir(output, { recursive: true });
  await mkdir('/tmp/agents-checkpoint-capture', { recursive: true });
  process.chdir('/tmp/agents-checkpoint-capture');
  const server = new ModelServer([
    [message('remembered-before-upgrade')],
    [
      call('record', { key: 'accepted' }, { callId: 'accepted-record' }),
      call('lookup', { key: 'pending' }, { callId: 'pending-lookup' }),
    ],
    [
      {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'seed-cell',
        input: 'store("retained", {value:29}); text("stored-before-upgrade");',
      },
    ],
    [message('code-before-upgrade')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-checkpoint-producer',
      supportsWebsockets: false,
    });
    const idle = new Agent({
      instructions: 'Remember checkpoint history.',
      model: 'gpt-5.5',
      provider,
    });
    {
      await using session = await idle.session();
      await (await session.submit('idle-before-upgrade')).wait();
      await writeFile(
        resolve(output, 'idle.json'),
        JSON.stringify(await session.saveState()),
      );
    }
    const effects: string[] = [];
    const record = tool({
      name: 'record',
      description: 'Record.',
      parameters: z.object({ key: z.string() }),
      execute: ({ key }) => {
        effects.push(key);
        return 'recorded-' + key;
      },
    });
    const lookup = manualTool({
      name: 'lookup',
      description: 'Read',
      parameters: z.object({ key: z.string() }),
      result: z.string(),
    });
    const manual = new Agent({
      instructions: 'Record and request a decision.',
      model: 'gpt-5.5',
      provider,
      tools: [record, lookup],
      outputType: { mode: 'prompted', schema: z.number().int() },
    });
    {
      await using session = await manual.session();
      const turn = await session.submit('manual-before-upgrade');
      const ended = turn.wait().catch((error: unknown) => error);
      let stale;
      for await (const event of session.events()) {
        if (event.type === 'action_requested') {
          stale = event.reply('expired');
          break;
        }
      }
      if (!stale) throw new Error('Missing manual request');
      await writeFile(
        resolve(output, 'manual.json'),
        JSON.stringify(await session.suspend()),
      );
      await ended;
      expect(effects).toEqual(['accepted']);
      await expect(session.respond(stale)).rejects.toThrow();
    }
    const code = new Agent({
      instructions: 'Store and read checkpoint values.',
      model: 'gpt-5.5',
      provider,
      programmaticToolCalling: true,
    });
    {
      await using session = await code.session();
      await (await session.submit('code-before-upgrade')).wait();
      const state = await session.saveState();
      expect(state.root_code_mode?.stored_values.retained).toEqual({
        value: 29,
      });
      expect(BigInt(state.root_code_mode!.next_cell_id)).toBeGreaterThan(1n);
      await writeFile(resolve(output, 'code.json'), JSON.stringify(state));
    }
    server.assertExhausted();
  } finally {
    await ModelServer.closeAll();
  }
  const cases = await Promise.all(
    ['idle', 'manual', 'code'].map(async (name) => ({
      file: name + '.json',
      sha256: await digest(resolve(output, name + '.json')),
      sdk_format_version: JSON.parse(
        await readFile(resolve(output, name + '.json'), 'utf8'),
      ).format_version,
    })),
  );
  const manifest = {
    format: 1,
    producer: {
      kind: 'source-snapshot',
      source_commit: sourceCommit,
      native_artifact_id: process.env.CHECKPOINT_PRODUCER_ARTIFACT_ID,
      native_archive_sha256: await digest(
        process.env.CHECKPOINT_PRODUCER_ARTIFACT!,
      ),
      native_receipt_sha256: await digest(
        resolve(source, 'packages/agents-codex/native/build-receipt.json'),
      ),
      codex_revision: (
        await readFile(
          resolve(source, 'packages/agents-codex/native/CODEX_REVISION'),
          'utf8',
        )
      ).trim(),
    },
    capture_script_sha256: await digest(process.env.CHECKPOINT_CAPTURE_SCRIPT!),
    cases,
  };
  await writeFile(
    resolve(output, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}, 90000);
