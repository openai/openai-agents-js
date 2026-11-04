import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  localStorage,
} from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it
  .skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
  .for([
    'implicit',
    'strict',
    'legacy',
    'malformed',
    'receipt-free implicit',
    'receipt-free strict',
    'receipt-free strict extra',
    'receipt-free model-only',
    'before sampling',
    'empty',
  ] as const)(
  'checks the durable write mode for %s receipts',
  { timeout: 30_000 },
  async (mode) => {
    const executor = await startPublicExecutor();
    try {
      const server = new ModelServer([[message('Original')]]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-worker',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const storage = localStorage(join(executor.cwd, '..', 'storage'));
      const connection = {
        url: executor.url,
        headers: executor.headers,
        cwd: executor.cwd,
        tools: ['exec_command'] as const,
      };
      const implicit = new Environment(connection);
      const writableRoots: string[] = [];
      if (mode === 'receipt-free strict extra') {
        const extra = join(executor.cwd, '..', 'extra');
        await mkdir(extra);
        writableRoots.push(extra);
      }
      const strict = new Environment({ ...connection, writableRoots });
      let source: Environment | undefined = implicit;
      if (mode === 'receipt-free model-only') source = undefined;
      else if (mode === 'strict' || mode.startsWith('receipt-free strict'))
        source = strict;
      const changed = source === strict ? implicit : strict;
      let resume: string;
      {
        await using session = await agent.session({
          storage,
          environment: source,
        });
        resume = session.id;
        expect(
          (await (await session.submit('Start.')).wait()).finalOutput,
        ).toBe('Original');
      }
      {
        await using reopened = await agent.session({
          storage,
          resume,
          environment: source,
        });
        expect(reopened.id).toBe(resume);
      }

      const entries = await readdir(storage.path, {
        withFileTypes: true,
        recursive: true,
      });
      const rollout = entries.find(
        (entry) => entry.isFile() && entry.name.endsWith(`${resume}.jsonl`),
      );
      if (!rollout) throw new Error('Expected the local rollout');
      const path = join(rollout.parentPath, rollout.name);
      let records = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const receipts = records
        .filter(
          (record) =>
            record.type === 'turn_context' &&
            record.payload.sdk_receipt?.thread_id === resume,
        )
        .map((record) => record.payload.sdk_receipt);
      expect(receipts).toHaveLength(1);
      const [receipt] = receipts;
      expect(receipt.strict_executor_writes).toBe(source === strict);
      expect(receipt.executors).toHaveLength(source === undefined ? 0 : 1);
      if (mode === 'legacy' || mode === 'malformed') {
        if (mode === 'legacy') delete receipt.strict_executor_writes;
        else receipt.strict_executor_writes = 'false';
      }
      if (mode.startsWith('receipt-free ')) {
        records = records.filter(
          (record) => record.payload.sdk_receipt !== receipt,
        );
      }
      if (mode === 'empty') {
        expect(records[0].type).toBe('session_meta');
        records = records.slice(0, 1);
      }
      if (mode === 'before sampling') {
        const firstReceipt = records.findIndex(
          (record) => record.payload.sdk_receipt === receipt,
        );
        const completed = records.find(
          (record) =>
            record.type === 'event_msg' &&
            record.payload.type === 'task_complete',
        );
        expect(completed).toBeDefined();
        expect(firstReceipt).toBeGreaterThan(0);
        records = [
          ...records.slice(0, firstReceipt),
          {
            ...completed,
            payload: {
              type: completed.payload.type,
              turn_id: completed.payload.turn_id,
              last_agent_message: null,
              error: { message: 'Failed before sampling' },
            },
          },
        ];
      }
      if (mode !== 'implicit' && mode !== 'strict') {
        await writeFile(
          path,
          records.map((record) => JSON.stringify(record)).join('\n') + '\n',
        );
      }

      const reopen = async (environment?: Environment) => {
        await using reopened = await agent.session({
          storage,
          resume,
          environment,
        });
        expect(reopened.id).toBe(resume);
      };
      if (mode.startsWith('receipt-free ')) {
        const policyError = /recorded executor write and network policy/;
        if (mode === 'receipt-free strict extra') {
          await expect(reopen()).rejects.toThrow(policyError);
          await expect(reopen(implicit)).rejects.toThrow(policyError);
        } else {
          await reopen();
          await reopen(implicit);
        }
        await expect(reopen(strict)).rejects.toThrow(policyError);
        if (mode === 'receipt-free implicit') {
          const explicitNetwork = new Environment({
            ...connection,
            network: { allowAllUnixSockets: true },
          });
          await expect(reopen(explicitNetwork)).rejects.toThrow(policyError);
        }
      } else if (
        mode === 'legacy' ||
        mode === 'before sampling' ||
        mode === 'empty'
      ) {
        await reopen(changed);
      } else {
        await expect(reopen(changed)).rejects.toThrow(
          /recorded executor write and network policy/,
        );
      }
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

it
  .skipIf(process.platform !== 'linux' && process.platform !== 'darwin')
  .for([
    'flag retained',
    'flag erased',
    'executors missing',
    'policy fields missing',
  ] as const)(
  'rejects an incomplete durable receipt after a strict executor turn with %s',
  { timeout: 30_000 },
  async (kind) => {
    const executor = await startPublicExecutor();
    try {
      const server = new ModelServer([[message('First')], [message('Second')]]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-worker',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const storage = localStorage(join(executor.cwd, '..', 'storage'));
      const connection = { url: executor.url, headers: executor.headers };
      let resume: string;
      {
        await using session = await agent.session({
          storage,
          environment: new Environment({
            ...connection,
            cwd: executor.cwd,
            writableRoots: [],
          }),
        });
        resume = session.id;
        await (await session.submit('First.')).wait();
        await (await session.submit('Second.')).wait();
      }
      const entries = await readdir(storage.path, {
        withFileTypes: true,
        recursive: true,
      });
      const rollout = entries.find(
        (entry) => entry.isFile() && entry.name.endsWith(`${resume}.jsonl`),
      );
      if (!rollout) throw new Error('Expected the local rollout');
      const path = join(rollout.parentPath, rollout.name);
      let records = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const receipts = records
        .filter(
          (record) =>
            record.type === 'turn_context' &&
            record.payload.sdk_receipt?.thread_id === resume,
        )
        .map((record) => record.payload.sdk_receipt);
      expect(receipts).toHaveLength(2);
      const latest = receipts.at(-1);
      expect(latest.strict_executor_writes).toBe(true);
      expect(latest.executors).toHaveLength(1);
      if (kind === 'executors missing' || kind === 'policy fields missing') {
        delete latest.executors;
      } else {
        latest.executors = [];
      }
      if (kind === 'policy fields missing')
        delete latest.strict_executor_writes;
      else latest.strict_executor_writes = kind !== 'flag erased';
      await writeFile(
        path,
        records.map((record) => JSON.stringify(record)).join('\n') + '\n',
      );

      const next = join(executor.cwd, 'new-write-root');
      await mkdir(next);
      const options =
        kind === 'flag erased'
          ? {}
          : {
              environment: new Environment({
                ...connection,
                cwd: executor.cwd,
                writableRoots:
                  kind === 'policy fields missing'
                    ? undefined
                    : kind === 'flag retained'
                      ? [next]
                      : [],
              }),
            };
      await expect(
        (async () => {
          await using resumed = await agent.session({
            ...options,
            storage,
            resume,
          });
          expect(resumed.id).toBe(resume);
        })(),
      ).rejects.toThrow(
        kind === 'executors missing' || kind === 'policy fields missing'
          ? /valid recorded executor policy/
          : /recorded executor write and network policy/,
      );
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'can attach a trusted implicit remote executor when reopening model-only history',
  { timeout: 30_000 },
  async () => {
    const executor = await startPublicExecutor();
    try {
      const server = new ModelServer([
        [message('First')],
        [message('Second')],
        [message('Third')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-local-worker',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const storage = localStorage(join(executor.cwd, '..', 'storage'));
      let resume: string;
      {
        await using session = await agent.session({ storage });
        resume = session.id;
        await (await session.submit('First.')).wait();
      }
      const connection = {
        url: executor.url,
        headers: executor.headers,
        cwd: executor.cwd,
        tools: ['exec_command'] as const,
      };
      await expect(
        (async () => {
          await using session = await agent.session({
            storage,
            resume,
            environment: new Environment({ ...connection, writableRoots: [] }),
          });
          expect(session.id).toBe(resume);
        })(),
      ).rejects.toThrow(/recorded executor write and network policy/);

      {
        await using reopened = await agent.session({
          storage,
          resume,
          environment: new Environment(connection),
        });
        expect(reopened.id).toBe(resume);
        expect(
          (await (await reopened.submit('Second.')).wait()).finalOutput,
        ).toBe('Second');
        expect(server.requests.at(-1)?.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'exec_command' }),
          ]),
        );
      }
      {
        await using modelOnly = await agent.session({ storage, resume });
        expect(
          (await (await modelOnly.submit('Third.')).wait()).finalOutput,
        ).toBe('Third');
      }
      // The latest empty receipt cannot hide the earlier executor grant.
      await expect(
        (async () => {
          await using session = await agent.session({
            storage,
            resume,
            environment: new Environment(connection),
          });
          expect(session.id).toBe(resume);
        })(),
      ).rejects.toThrow(/recorded executor write and network policy/);
      await using modelOnly = await agent.session({ storage, resume });
      expect(modelOnly.id).toBe(resume);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);
