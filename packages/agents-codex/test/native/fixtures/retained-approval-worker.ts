import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  tool,
  type ToolContext,
} from '@openai/agents';
import {
  readMemory,
  type MemoryContext,
} from '../../../../../examples/codex/application-memory';

const config = JSON.parse(process.argv[2]) as {
  url: string;
  profile: string;
  effects: string;
  resume?: string;
};
const action = {
  id: 'case-42',
  description: 'Record the selected application action',
};
const stages: string[] = [];
let lookupCompleted = false;

function control(type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const receive = (message: unknown) => {
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== type
      )
        return;
      process.off('message', receive);
      resolve(message as Record<string, unknown>);
    };
    process.on('message', receive);
  });
}

async function main() {
  await using provider = new NativeProvider({
    baseUrl: config.url,
    apiKey: config.resume
      ? 'synthetic-current-destination'
      : 'synthetic-source',
    supportsWebsockets: false,
  });
  const context: MemoryContext = {
    tenantId: 'trusted-tenant',
    memory: {
      async readNote(tenantId, key) {
        assert.equal(tenantId, 'trusted-tenant');
        assert.equal(key, 'selected-action');
        stages.push('lookup');
        lookupCompleted = true;
        return JSON.stringify(action);
      },
    },
  };
  const agent = new Agent<MemoryContext>({
    instructions:
      'Look up the selected action and execute it only through execute_action.',
    model: 'gpt-5',
    provider,
    tools: [
      readMemory,
      tool({
        name: 'execute_action',
        parameters: z.object({ id: z.string() }),
        async before(info: ToolContext<MemoryContext>) {
          assert(lookupCompleted, 'Application lookup must precede approval');
          assert.equal(info.effectiveArguments.id, action.id);
          stages.push('approval');
          const decision = control('decision');
          process.send?.({ type: 'approval', action, stages: [...stages] });
          const received = await decision;
          assert.equal(typeof received.allow, 'boolean');
          return received.allow
            ? { action: 'allow' as const }
            : {
                action: 'deny' as const,
                reason: 'Application denied action case-42',
              };
        },
        async execute({ id }) {
          stages.push('execute');
          await appendFile(
            config.effects,
            JSON.stringify({ id, receipt: 'effect-1' }) + '\n',
          );
          process.send?.({ type: 'effect', id });
          return { id, receipt: 'effect-1' };
        },
      }),
    ],
  });
  {
    await using session = await agent.session({
      storage: localStorage(config.profile),
      resume: config.resume,
      context,
    });
    const history = [];
    for await (const item of session.items()) history.push(item);
    const begin = control('continue');
    process.send?.({ type: 'opened', id: session.id, history });
    await begin;
    const result = await (
      await session.submit(
        config.resume
          ? 'Summarize the previous action result. Do not perform another action.'
          : 'Look up selected-action, then request the selected action.',
      )
    ).wait();
    process.send?.({ type: 'result', output: result.finalOutput, stages });
  }
}

void main()
  .then(
    () => process.send?.({ type: 'done' }),
    (error: unknown) => {
      process.exitCode = 1;
      process.send?.({
        type: 'failure',
        message: error instanceof Error ? error.stack : String(error),
      });
    },
  )
  .finally(() => process.disconnect?.());
