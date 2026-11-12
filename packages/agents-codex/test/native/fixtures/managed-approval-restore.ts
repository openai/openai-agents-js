import { appendFileSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  parseSessionState,
  tool,
} from '../../../src';

async function main() {
  const [statePath, effectsPath, baseUrl, decision, turnId, mode, maxRequests] =
    process.argv.slice(2);
  const guarded = mode === 'guarded';
  const predicates: string[] = [];
  const guards: string[] = [];
  const risky = tool({
    name: 'risky',
    description: 'Synthetic effect',
    parameters: z.object({ value: z.string() }),
    runBeforeApproval: guarded,
    before: guarded
      ? (context) => {
          guards.push(String(context.effectiveArguments.value));
          return { action: 'allow' };
        }
      : undefined,
    needsApproval: (context) => {
      predicates.push(context.callId);
      return false;
    },
    execute: ({ value }) => {
      appendFileSync(effectsPath, 'risky\n');
      return 'accepted-' + value;
    },
  });
  const accepted = tool({
    name: 'accepted',
    description: 'Accepted sibling',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      appendFileSync(effectsPath, 'accepted\n');
      return 'sibling-' + value;
    },
  });
  await using provider = new NativeProvider({
    baseUrl,
    apiKey: 'synthetic-approval-restore',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use both tools.',
    model: 'gpt-5',
    provider,
    tools: [accepted, risky],
  });
  await using session = await agent.session({
    state: parseSessionState(readFileSync(statePath, 'utf8')),
    resumeBudget:
      maxRequests === undefined
        ? undefined
        : { maxRequests: Number(maxRequests) },
  });
  const turn = session.restoredTurn;
  if (!turn || turn.turnId !== turnId)
    throw new Error('Restored native Turn identity changed');
  let found = false;
  for await (const request of session.interactions()) {
    if (!isFunctionApprovalRequest(request)) continue;
    found = true;
    if (request.callId !== 'pending-approval' || request.turnId !== turnId)
      throw new Error('Restored call identity changed');
    if (readFileSync(effectsPath, 'utf8') !== 'accepted\n' || predicates.length)
      throw new Error(
        'Restored pending requirement or accepted sibling was replayed',
      );
    if (guards.length)
      throw new Error('Completed preapproval input guard repeated');
    if (
      (request.effectiveArguments as { value: string }).value !==
      (guarded ? 'B-pre' : 'B')
    )
      throw new Error('Captured effective input changed');
    const reply =
      decision === 'approve'
        ? request.approve()
        : request.reject('restored rejection');
    await session.respond(reply);
    try {
      await session.respond(reply);
      throw new Error('duplicate accepted');
    } catch (error) {
      if (error instanceof Error && error.message === 'duplicate accepted')
        throw error;
    }
    break;
  }
  if (!found) throw new Error('Captured required approval was bypassed');
  const result = await turn.wait();
  if (result.finalOutput !== 'resumed') throw new Error('Wrong resumed output');
  if (
    JSON.stringify(guards) !==
    JSON.stringify(guarded && decision === 'approve' ? ['B-pre'] : [])
  )
    throw new Error('Reexecution input guard scheduling changed');
  await session.saveState();
  console.log(
    JSON.stringify({
      turnId,
      predicates,
      effects: readFileSync(effectsPath, 'utf8').trim().split('\n'),
    }),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
