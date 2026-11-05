import {
  Agent,
  RunHooks,
  ToolGuardrailFunctionOutputFactory,
  tool,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { MigrationCleanupError, SDKRunner } from '@openai/agents/migration';
import { z } from 'zod';

type OrderContext = { accountId: string };

/** Exercise SDK guardrails on the native loop with a scripted, offline Model. */
export async function runGuardedMigration() {
  const parameters = z.object({});
  const orderStatus = tool<typeof parameters, OrderContext>({
    name: 'order_status',
    description: 'Look up the current account order.',
    parameters,
    inputGuardrails: [
      {
        name: 'signed in',
        async run({ context }) {
          return context.context.accountId
            ? ToolGuardrailFunctionOutputFactory.allow()
            : ToolGuardrailFunctionOutputFactory.rejectContent(
                'Please sign in.',
              );
        },
      },
    ],
    execute: async (_input, context) => ({
      accountId: context!.context.accountId,
      status: 'shipped',
    }),
    outputGuardrails: [
      {
        name: 'customer visible result',
        async run({ output }) {
          return output && typeof output === 'object' && 'accountId' in output
            ? ToolGuardrailFunctionOutputFactory.rejectContent(
                'Your order has shipped.',
              )
            : ToolGuardrailFunctionOutputFactory.allow();
        },
      },
    ],
  });
  const agent = new Agent<OrderContext>({
    name: 'Order assistant',
    instructions: 'Look up the order and report its customer-visible status.',
    tools: [orderStatus],
    model: new ScriptedModel([
      modelResponse([functionCall('order_status', '{}', { callId: 'order' })]),
      modelResponse([assistantMessage('Your order has shipped.')]),
    ]),
    modelSettings: {},
    inputGuardrails: [
      {
        name: 'nonempty request',
        runInParallel: false,
        async execute({ input }) {
          return {
            tripwireTriggered: typeof input === 'string' && !input.trim(),
            outputInfo: undefined,
          };
        },
      },
    ],
    outputGuardrails: [
      {
        name: 'no account identifiers',
        async execute({ agentOutput, context }) {
          return {
            tripwireTriggered: agentOutput.includes(context.context.accountId),
            outputInfo: undefined,
          };
        },
      },
    ],
  });
  const hooks = new RunHooks<OrderContext>();
  hooks.on('agent_tool_end', (_context, _agent, _tool, output) => {
    console.log('Tool result:', output);
  });
  try {
    const result = await SDKRunner.run(agent, 'Where is my order?', {
      context: { accountId: 'account-123' },
      hooks,
    });
    console.log(result.finalOutput);
    return result;
  } catch (error) {
    if (error instanceof MigrationCleanupError) await error.retryCleanup();
    throw error;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  runGuardedMigration().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
