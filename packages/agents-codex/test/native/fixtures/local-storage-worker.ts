import { appendFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import type { MCPServer } from '@openai/agents-core';
import { z } from 'zod';
import {
  Agent,
  LocalRecoveryRequired,
  NativeProvider,
  NativeAgents,
  Environment,
  localStorage,
  selectMcpTools,
  shellTool,
  tool,
  type ReconciledCall,
  type ToolContext,
} from '../../../src/index';

const config = JSON.parse(process.argv[2]) as {
  profile: string;
  effects: string;
  url: string;
  label: string;
  mode: 'run' | 'hold-before' | 'hold-effect' | 'hold-open';
  reconciledCalls?: ReconciledCall[];
  resume?: string;
  apiKey?: string;
  selectedMcp?: boolean;
  applicationShell?: boolean;
  nativeChildren?: boolean;
  inspectChildren?: boolean;
  environment?: { url: string; cwd: string; headers: Record<string, string> };
};
const provider = new NativeProvider({
  baseUrl: config.url,
  apiKey: config.apiKey ?? `synthetic-${config.label}`,
  supportsWebsockets: false,
});
const context = { label: config.label };
async function record(label: string) {
  if (config.mode === 'hold-before') {
    process.send?.({ type: 'beforeEffect' });
    await new Promise(() => {});
  }
  await appendFile(config.effects, label + '\n');
  process.send?.({ type: 'effect' });
  if (config.mode === 'hold-effect') await new Promise(() => {});
  return label;
}

async function recordTools() {
  if (config.applicationShell) {
    return [
      shellTool<{ label: string }>({
        async execute(_call, { context }) {
          const stdout = await record(context.label);
          return {
            output: [
              { stdout, stderr: '', outcome: { type: 'exit', exit_code: 0 } },
            ],
          };
        },
      }),
    ];
  }
  if (config.selectedMcp) {
    const server: MCPServer = {
      name: 'worker-peer',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      invalidateToolsCache: async () => {},
      listTools: async () => [
        {
          name: 'record',
          description: 'Record one application effect.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      callTool: async () => [
        { type: 'text', text: await record(context.label) },
      ],
    };
    return selectMcpTools(
      { name: 'worker', server },
      { context, toolNames: ['record'], approval: () => true },
    );
  }
  return [
    tool({
      name: 'record',
      description: 'Record one application effect.',
      parameters: z.object({}),
      execute: (_args, { context }: ToolContext<{ label: string }>) =>
        record(context.label),
    }),
  ];
}

async function main() {
  try {
    const agent = new Agent<{ label: string }>({
      instructions:
        'Use the current managed record tool. Preserve conversation history.',
      model: config.selectedMcp || config.nativeChildren ? 'gpt-5.5' : 'gpt-5',
      provider,
      tools: [
        ...(await recordTools()),
        ...(config.nativeChildren ? [new NativeAgents()] : []),
      ],
    });
    if (config.reconciledCalls !== undefined && config.resume === undefined)
      throw new TypeError('reconciledCalls requires local storage and resume');
    const persistence =
      config.resume === undefined
        ? { storage: localStorage(config.profile) }
        : {
            storage: localStorage(config.profile),
            resume: config.resume,
            reconciledCalls: config.reconciledCalls,
          };
    const session = await agent.session({
      ...persistence,
      context,
      ...(config.environment
        ? {
            environment: new Environment({
              ...config.environment,
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
            }),
          }
        : {}),
    });
    const history = async () => {
      const items = [];
      const turns = [];
      for await (const item of session.items()) items.push(item);
      for await (const turn of session.turns()) turns.push(turn);
      const descendants = [];
      if (config.inspectChildren) {
        for await (const child of session.subagents()) {
          const turns = [];
          for await (const turn of session.turns({ subagentId: child.id }))
            turns.push(turn);
          descendants.push({ id: child.id, isLive: child.isLive, turns });
        }
      }
      return {
        items,
        turns,
        ...(config.inspectChildren ? { descendants } : {}),
      };
    };
    process.send?.({
      type: 'opened',
      id: session.id,
      history: await history(),
    });
    try {
      if (config.mode === 'hold-open') {
        await new Promise<void>((resolve) =>
          process.once('message', () => resolve()),
        );
      } else {
        const result = await (
          await session.submit('Use the record tool if requested.')
        ).wait();
        process.send?.({
          type: 'result',
          output: result.finalOutput,
          history: await history(),
        });
      }
    } finally {
      await session.close();
    }
    await provider.close();
    process.send?.({ type: 'done' });
  } catch (error) {
    const inspection =
      error instanceof LocalRecoveryRequired
        ? {
            calls: error.calls,
            turns: error.turns.map(({ id, status }) => ({ id, status })),
            items: error.items,
          }
        : {};
    process.send?.({
      type: 'failure',
      message: error instanceof Error ? error.message : String(error),
      details: inspect(error, { depth: null }),
      ...inspection,
    });
    try {
      await provider.close();
    } catch {
      /* The parent observes failure and owns the worker. */
    }
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}
void main();
