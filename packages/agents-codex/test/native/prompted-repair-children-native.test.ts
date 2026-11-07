import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Environment, NativeAgents, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Uses the existing local native executor/relay fixture for NativeAgents
// admission. The model never requests OS commands or external provisioning.
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native children remain independent of owned root output repair',
  () => {
    it.each(['complete', 'cancel-root'] as const)(
      '%s leaves an admitted child running and excludes its tools from correction',
      async (finish) => {
        const executor = await startPublicExecutor();
        const childEntered = Promise.withResolvers<void>();
        const childRelease = Promise.withResolvers<void>();
        const repairEntered = Promise.withResolvers<void>();
        const repairRelease = Promise.withResolvers<void>();
        let rootId: string | undefined;
        let rootRequests = 0;
        let rootOutcome = 'not submitted';
        let childOutcome = 'not observed';
        const phases: string[] = [];
        const correctionRequests: JsonObject[] = [];
        const childRequests: JsonObject[] = [];
        const respond = async (request: JsonObject) => {
          if (
            (request.tools as unknown[] | undefined)?.length === 0 ||
            !request.tools
          ) {
            correctionRequests.push(request);
            repairEntered.resolve();
            await repairRelease.promise;
            return [message('{"label":"corrected"}')];
          }
          const metadata = request.client_metadata as Record<string, string>;
          const id = String(
            JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
          );
          rootId ??= id;
          if (id === rootId) {
            if (++rootRequests === 1)
              return [
                call(
                  'spawn_agent',
                  {
                    task_name: 'research',
                    message: 'Complete independent research.',
                  },
                  {
                    namespace: 'collaboration',
                    callId: 'spawn-independent-child',
                  },
                ),
              ];
            // Establish a real child model request before the original invalid
            // output starts repair. The child's response remains independently held.
            await childEntered.promise;
            return [message('{"label":"x"}')];
          }
          childRequests.push(request);
          childEntered.resolve();
          await childRelease.promise;
          return [message('independent child complete')];
        };
        const server = new ModelServer(
          Array.from({ length: 4 }, () => respond),
        );
        server.onRecord = (phase) => phases.push(phase);
        const waitForPhase = async <T>(
          name: string,
          pending: Promise<T>,
        ): Promise<T> => {
          phases.push(`BEGIN ${name}`);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const diagnostic = () =>
            JSON.stringify({
              finish,
              phase: name,
              rootId,
              rootRequests,
              modelRequests: server.requests.length,
              completedFrames: server.completedFrames.length,
              correctionRequests: correctionRequests.length,
              childRequests: childRequests.length,
              rootOutcome,
              childOutcome,
              phases,
            });
          try {
            const result = await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(
                    new Error(
                      `Native child repair phase did not finish within 8s: ${diagnostic()}`,
                    ),
                  );
                }, 8000);
              }),
            ]);
            phases.push(`END ${name}`);
            return result;
          } catch (error) {
            const detail = `Native child repair phase ${name} failed: ${diagnostic()}`;
            // Preserve the phase even if subsequent teardown also stalls.
            console.error(detail);
            throw new Error(detail, { cause: error });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        };
        const config = await server.config();
        let provider: NativeProvider | undefined;
        try {
          provider = new NativeProvider({
            baseUrl: (config['model_providers.fixture'] as { base_url: string })
              .base_url,
            apiKey: 'synthetic-child-repair-key',
            supportsWebsockets: false,
          });
          const session = await new Agent({
            instructions: 'Delegate once.',
            model: 'gpt-5.5',
            provider,
            tools: [new NativeAgents()],
          }).session({
            environment: new Environment({
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
            }),
          });
          try {
            // Only this original root receives the output contract. The actual
            // child keeps its own plain output and its original native identity.
            const root = await waitForPhase(
              'original root submission',
              session.submitWithOutput('Start independent research.', {
                mode: 'prompted',
                schema: z.object({ label: z.string().min(2) }),
                maxRetries: 2,
              }),
            );
            rootOutcome = 'pending';
            const rootResult = root.wait();
            void rootResult.then(
              () => {
                rootOutcome = 'fulfilled';
              },
              (error: unknown) => {
                rootOutcome = `rejected: ${String(error)}`;
              },
            );
            const unexpectedRootCompletion = rootResult.then(() => {
              throw new Error(
                'Original root completed before the held repair admission',
              );
            });
            await waitForPhase(
              'child model request admission',
              Promise.race([childEntered.promise, unexpectedRootCompletion]),
            );
            await waitForPhase(
              'correction model request admission',
              Promise.race([repairEntered.promise, unexpectedRootCompletion]),
            );
            const children = await waitForPhase(
              'initial child list/read',
              vi.waitFor(
                async () => {
                  const result = await Array.fromAsync(session.subagents());
                  expect(result[0]?.turn).toBeTruthy();
                  return result;
                },
                { timeout: 5_000 },
              ),
            );
            expect(children).toHaveLength(1);
            const child = children[0].turn;
            if (!child) throw new Error('Expected a real live child Turn');
            const childIdentity = {
              childId: child.childId,
              turnId: child.turnId,
              submissionId: child.submissionId,
            };
            let childSettled = false;
            childOutcome = 'pending';
            const childResult = child.wait();
            void childResult.then(
              () => {
                childSettled = true;
                childOutcome = 'fulfilled';
              },
              (error: unknown) => {
                childSettled = true;
                childOutcome = `rejected: ${String(error)}`;
              },
            );
            childResult.catch(() => {});
            expect(childSettled).toBe(false);
            expect(correctionRequests).toHaveLength(1);
            expect(correctionRequests[0].tools ?? []).toEqual([]);
            expect(childRequests).toHaveLength(1);
            expect(JSON.stringify(childRequests[0].tools)).toContain(
              'exec_command',
            );
            if (finish === 'cancel-root') {
              const stopping = root.cancel({ mode: 'force' });
              repairRelease.resolve();
              await waitForPhase('root-only force cancellation', stopping);
              await waitForPhase(
                'cancelled root result',
                expect(rootResult).rejects.toThrow(),
              );
            } else {
              repairRelease.resolve();
              const completed = await waitForPhase(
                'root repair completion',
                rootResult,
              );
              expect(completed.finalOutput).toEqual({ label: 'corrected' });
              expect(completed.repairAttempts).toHaveLength(1);
              expect(
                await waitForPhase('cached repaired root result', root.wait()),
              ).toBe(completed);
            }
            expect(childSettled).toBe(false);
            const stillLive = await waitForPhase(
              'surviving child list/read',
              (async () => {
                const result = [];
                for await (const record of session.subagents())
                  result.push(record);
                return result;
              })(),
            );
            expect(stillLive[0]).toMatchObject({
              id: childIdentity.childId,
              isLive: true,
            });
            expect(child.childId).toBe(childIdentity.childId);
            expect(child.turnId).toBe(childIdentity.turnId);
            expect(child.submissionId).toBe(childIdentity.submissionId);
            expect(correctionRequests).toHaveLength(1);
            childRelease.resolve();
            const completedChild = await waitForPhase(
              'independent child completion',
              childResult,
            );
            expect(completedChild.finalOutput).toBe(
              'independent child complete',
            );
            expect(completedChild.repairAttempts).toEqual([]);
            expect(childRequests).toHaveLength(1);
            expect(server.requests).toHaveLength(4);
            server.assertExhausted();
          } finally {
            childRelease.resolve();
            repairRelease.resolve();
            await waitForPhase('Session close', session.close());
          }
        } finally {
          childRelease.resolve();
          repairRelease.resolve();
          try {
            if (provider)
              await waitForPhase('provider close', provider.close());
          } finally {
            await waitForPhase('executor close', executor.close());
          }
        }
      },
      45000,
    );
  },
);
