/* global process */
import assert from 'node:assert/strict';
import {
  copyFile,
  link,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const [codexHome, accountId, mode, sandboxPolicy] = process.argv.slice(2);

async function waitForGrant(directory) {
  while (
    (await readFile(join(directory, 'grant-consumed')).catch(
      () => undefined,
    )) === undefined
  ) {
    await delay(10);
  }
}

let stage = 'import the root SDK';
try {
  const { Agent, Environment, NativeProvider, imageGeneration, webSearch } =
    await import('@openai/agents');
  stage = 'construct the provider';
  const provider = new NativeProvider({
    codexLogin: {
      codexHome,
      accountId: mode === 'mismatch' ? 'different-workspace' : accountId,
    },
    supportsWebsockets: false,
  });
  try {
    const agentOptions = {
      instructions: 'Answer briefly.',
      model: 'gpt-5.5',
      provider,
    };
    const agent = new Agent({
      ...agentOptions,
      programmaticToolCalling: mode === 'code',
      ...(mode === 'hosted-media'
        ? { tools: [webSearch({ route: 'hosted' }), imageGeneration()] }
        : {}),
    });
    if (mode === 'mismatch') {
      let unexpectedSession;
      try {
        stage = 'reject standalone search before checking the saved account';
        await assert.rejects(async () => {
          unexpectedSession = await new Agent({
            ...agentOptions,
            tools: [webSearch()],
          }).session();
        }, /standalone web search.*route: 'hosted'/i);
        stage = 'reject the mismatched account before opening a Session';
        await assert.rejects(async () => {
          unexpectedSession = await agent.session();
        }, /does not match the expected account/i);
      } finally {
        await unexpectedSession?.close();
      }
    } else if (mode === 'repair') {
      const schema = z.object({ answer: z.string() });
      const prompted = { mode: 'prompted', schema, maxRetries: 0 };
      const repair = { ...prompted, maxRetries: 1 };
      const unsupported = /does not support output repair/;
      stage = 'reject a positive opening repair budget';
      await assert.rejects(async () => {
        const unexpected = await new Agent({
          ...agentOptions,
          outputType: repair,
        }).session();
        await unexpected.close();
      }, unsupported);
      stage = 'reject a positive handoff repair budget';
      await assert.rejects(async () => {
        const unexpected = await new Agent({
          ...agentOptions,
          outputType: prompted,
          handoffs: [
            new Agent({ ...agentOptions, name: 'target', outputType: repair }),
          ],
        }).session();
        await unexpected.close();
      }, unsupported);
      stage = 'reject positive submission and queue repair budgets';
      const session = await agent.session();
      try {
        await assert.rejects(
          () => session.submit('Reject repair.', { outputType: repair }),
          unsupported,
        );
        await assert.rejects(
          () =>
            session.enqueue('Reject queued repair.', { outputType: repair }),
          unsupported,
        );
      } finally {
        await session.close();
      }
      stage = 'accept native output and prompted output without repair';
      for (const outputType of [prompted, { mode: 'native', schema }]) {
        const supported = await new Agent({
          ...agentOptions,
          outputType,
        }).session();
        await supported.close();
      }
    } else if (mode === 'realtime') {
      const session = await agent.session();
      try {
        stage = 'reject Realtime without a voice key';
        await assert.rejects(
          () => session.realtime({ model: 'fixture-realtime' }),
          /requires.*(?:API|voice).*key/i,
        );
        stage = 'open Realtime with its explicit API key';
        const voice = await session.realtime({
          model: 'fixture-realtime',
          apiKey: 'synthetic-realtime-key',
        });
        await voice.close();
      } finally {
        await session.close();
      }
    } else if (mode === 'overlap' || mode === 'local') {
      stage = 'resolve synthetic workspace and login paths';
      const canonicalHome = await realpath(codexHome);
      const directory = dirname(canonicalHome);
      const workspace = join(directory, 'workspace');
      const extra = join(directory, 'extra');
      const mount = join(directory, 'mount');
      const cache = join(canonicalHome, 'auth.json');
      const overlap =
        /Keep the saved Codex login outside local executor grants/;
      const rejectsGrant = (open, expected = overlap) =>
        assert.rejects(
          open,
          (error) =>
            error instanceof Error &&
            expected.test(error.message) &&
            !error.message.includes(canonicalHome) &&
            !error.message.includes(codexHome),
        );
      const open = (options, sessionOptions) =>
        agent.session({
          ...sessionOptions,
          environment: Environment.local({
            cwd: workspace,
            tools: ['exec_command'],
            approval: () => true,
            ...options,
          }),
        });
      if (mode === 'overlap') {
        const rejectsOpening = (options, expected) =>
          rejectsGrant(async () => {
            const session = await open(options);
            await session.close();
          }, expected);
        stage = 'reject a credential directory as cwd';
        await rejectsOpening({ cwd: canonicalHome });
        stage = 'reject a writable grant resolving to the credential directory';
        await rejectsOpening({ writableRoots: [codexHome] });

        for (const [grant, root, options, expected] of [
          ['cwd', workspace, {}, overlap],
          [
            'additional writable root',
            extra,
            { writableRoots: [extra] },
            overlap,
          ],
          [
            'read-only mount',
            mount,
            { mounts: [{ source: mount }] },
            /Storage mounts must not expose private SDK state/,
          ],
        ]) {
          stage = `reject a credential hard link in the ${grant}`;
          const alias = join(root, 'synthetic-link');
          await link(cache, alias);
          try {
            await rejectsOpening(options, expected);
          } finally {
            await rm(alias);
          }
        }
      } else {
        const sourceHome = join(directory, 'source-login');
        const relocated = join(directory, 'relocated-login');
        const assertPortableState = (state) => {
          const portable = JSON.stringify(state);
          assert(
            ![canonicalHome, codexHome, sourceHome, relocated].some((path) =>
              portable.includes(path),
            ),
            'Configured Session state contained a login path',
          );
          assert(
            !/synthetic-[a-z]+-(access|refresh)|\.synthetic/.test(portable),
            'Configured Session state contained credential material',
          );
        };
        stage = 'open a configured local Session';
        const session = await open({}).catch((error) => {
          if (
            sandboxPolicy === 'optional-sandbox' &&
            error instanceof Error &&
            error.message ===
              'local executor could not establish the platform sandbox'
          ) {
            return undefined;
          }
          throw error;
        });
        if (!session) {
          process.stdout.write('local sandbox unavailable');
        } else {
          let state;
          try {
            stage = 'run a configured workspace command';
            const turn = await session.submit('Write the workspace marker.');
            assert(
              (await turn.wait()).finalOutput ===
                'Accepted configured local execution.',
            );
            assert(
              (await readFile(join(workspace, 'effect.txt'), 'utf8')) ===
                'local-effect',
            );
            stage = 'check configured Session state before compaction';
            assertPortableState(await session.saveState());

            stage = 'replace the engine with the original saved login';
            await rm(codexHome);
            await symlink(sourceHome, codexHome);
            await session.compact({
              summary: 'The workspace marker was written.',
            });

            stage =
              'reject writable roots covering a credential link hop or target';
            const hop = join(extra, 'synthetic-hop');
            const target = join(mount, 'synthetic-cache');
            await rename(cache, target);
            try {
              await symlink(target, hop);
              await symlink(hop, cache);
              for (const root of [extra, mount]) {
                await rejectsGrant(() =>
                  session.submit('Reject this grant.', {
                    writableRoots: [root],
                  }),
                );
              }
            } finally {
              await rm(cache, { force: true });
              await rename(target, cache);
            }

            stage = 'continue local execution after rejected grants';
            const continuation = await session.submit(
              'Confirm the workspace marker.',
            );
            assert(
              (await continuation.wait()).finalOutput ===
                'Accepted configured local execution.',
            );
            stage =
              'check configured Session state after compaction and continuation';
            state = await session.saveState();
            assertPortableState(state);
          } finally {
            await session.close();
          }

          stage =
            'restore with the relocated saved login and same executor policy';
          await mkdir(relocated);
          await copyFile(cache, join(relocated, 'auth.json'));
          const relocatedProvider = new NativeProvider({
            codexLogin: { codexHome: relocated, accountId },
            supportsWebsockets: false,
          });
          try {
            const restored = await open(
              {},
              { provider: relocatedProvider, state },
            );
            try {
              stage = 'protect the relocated saved login from new write roots';
              await rejectsGrant(() =>
                restored.submit('Reject the relocated grant.', {
                  writableRoots: [relocated],
                }),
              );
              stage = 'continue the restored Session';
              const turn = await restored.submit('Confirm restored execution.');
              assert(
                (await turn.wait()).finalOutput ===
                  'Accepted configured local execution.',
              );
              stage = 'check restored Session state for private data';
              assertPortableState(await restored.saveState());
            } finally {
              await restored.close();
            }
          } finally {
            await relocatedProvider.close();
          }
        }
      }
    } else if (mode === 'code') {
      stage = 'open a saved login Code Mode Session';
      const session = await agent.session();
      try {
        stage = 'run the Code Mode cell and check the completed turn';
        const turn = await session.submit('Run the fixture cell.');
        assert((await turn.wait()).finalOutput === 'Accepted Code Mode.');
        const state = await session.saveState();
        assert(state.root_code_mode?.stored_values.savedLoginFixture === 'ran');
      } finally {
        await session.close();
      }
    } else if (mode === 'stalled-refresh') {
      const directory = dirname(codexHome);
      stage = 'open a Session with the expired saved login';
      const session = await agent.session();
      try {
        stage = 'cancel the Turn while the OAuth response body stalls';
        const turn = await session.submit('Exercise a stalled refresh.');
        const completed = turn.wait();
        void completed.catch(() => undefined);
        await waitForGrant(directory);
        await turn.cancel({ mode: 'force' });
        await assert.rejects(completed, /interrupt|cancel/i);
        stage = 'close the Session while the OAuth response body stalls';
      } finally {
        await session.close();
      }
      stage = 'open another saved login in the same process';
      const nextProvider = new NativeProvider({
        codexLogin: { codexHome: join(directory, 'copied-login'), accountId },
        supportsWebsockets: false,
      });
      try {
        const next = await new Agent({
          ...agentOptions,
          provider: nextProvider,
        }).session();
        try {
          stage = 'submit with the other saved login';
          const turn = await next.submit(
            'Confirm that refresh permits were released.',
          );
          assert((await turn.wait()).finalOutput === 'Accepted rotated login.');
        } finally {
          await next.close();
        }
      } finally {
        await nextProvider.close();
      }
    } else {
      stage = 'open the Sessions and submit their turns';
      const cancelAll = mode === 'cancel-all-refresh';
      const cancelRefresh = mode === 'cancel-refresh' || cancelAll;
      const count = mode === 'refresh' || cancelRefresh ? 3 : 1;
      const allCancelled = Promise.withResolvers();
      let cancelled = 0;
      const results = await Promise.allSettled(
        Array.from({ length: count }, async (_, index) => {
          let operation = 'open a Session';
          let session;
          const winner = cancelRefresh && index === 0;
          const directory = dirname(codexHome);
          try {
            session = await agent.session(
              mode === 'hosted-media' ? { discoverAgentsMd: true } : undefined,
            );
            if (winner) {
              await writeFile(join(directory, 'refresh-winner'), session.id);
            }
            operation = 'submit the turn';
            const turn = await session.submit('Exercise saved Codex login.');
            operation = 'wait for the turn';
            const completed = turn.wait();
            if (winner || cancelAll) {
              void completed.catch(() => undefined);
              operation = 'cancel the Turn after the grant is consumed';
              await waitForGrant(directory);
              await turn.cancel({ mode: 'force' });
              await assert.rejects(completed, /interrupt|cancel/i);
              if (!cancelAll || ++cancelled === count) {
                await writeFile(join(directory, 'turn-cancelled'), 'yes');
                allCancelled.resolve();
              }
              await allCancelled.promise;
              return null;
            }
            const result = await completed;
            operation = 'read the completed turn';
            assert(result.finalOutput === 'Accepted rotated login.');
            operation = 'save the Session state';
            const state = await session.saveState();
            operation = 'read recorded turn receipts';
            const recordedTurns = [];
            for await (const recorded of session.turns()) {
              recordedTurns.push(recorded);
            }
            assert(recordedTurns.some((recorded) => recorded.receipt));
            operation = 'serialize public state and receipts';
            const publicData = JSON.stringify({
              state,
              recordedTurns,
              finalOutput: result.finalOutput,
              threadUsage: result.threadUsage,
            });
            operation = 'check access and refresh token redaction';
            assert(!/synthetic-[a-z]+-(access|refresh)/.test(publicData));
            operation = 'check ID token redaction';
            assert(!publicData.includes('.synthetic'));
            operation = 'check credential directory redaction';
            assert(!publicData.includes(codexHome));
            return null;
          } catch {
            return operation;
          } finally {
            if (session && winner && cancelAll) {
              const closing = session.close();
              void closing.catch(() => undefined);
              await writeFile(join(directory, 'owner-closing'), 'yes');
              await closing;
              await writeFile(join(directory, 'owner-closed'), 'yes');
              const cache = JSON.parse(
                await readFile(join(codexHome, 'auth.json'), 'utf8'),
              );
              assert(
                cache.tokens?.refresh_token === 'synthetic-rotated-refresh',
              );
            } else {
              await session?.close();
            }
          }
        }),
      );
      const failed = results.find(
        (result) => result.status === 'rejected' || result.value !== null,
      );
      if (failed) {
        stage =
          failed.status === 'fulfilled' ? failed.value : 'close a Session';
        throw new Error('Session fixture failed');
      }
    }
    stage = 'close the provider';
  } finally {
    await provider.close();
  }
} catch {
  // Native errors can carry request diagnostics. Emit only the fixture stage.
  process.stdout.write(stage);
  process.exitCode = 1;
}
