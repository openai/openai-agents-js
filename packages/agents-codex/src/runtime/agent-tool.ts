import { z } from 'zod';
import type { Agent, Session } from './public-agent';
import type { Environment } from './environment';
import type { Completed } from './session';
import type { SessionState } from './state';
import { encode, jsonValue } from './binding';
import {
  bindConfiguredAgentRole,
  invokeConfiguredAgentTool,
  tool,
  toolDeclarationIdentity,
  type FunctionTool,
  type SessionTool,
} from './tools';

export interface AgentAsToolOptions<Output = string> {
  toolName: string;
  toolDescription?: string;
  customOutputExtractor?: (
    result: Completed<Output>,
  ) => string | Promise<string>;
}

export interface ConfiguredAgentTool {
  readonly resultSchema: { readonly type: 'string' };
  open(
    context: unknown,
    environment: Environment | null,
    signal: AbortSignal,
    state?: SessionState,
    verifiedExecutorCheckpoint?: boolean,
  ): Promise<Session<unknown>>;
  extract(result: Completed<unknown>): Promise<string>;
}

const declarations = new WeakMap<object, ConfiguredAgentTool>();

/** @internal Only SDK-created declarations have been admitting configured children. */
export function configuredAgentTool(
  declaration: SessionTool,
): ConfiguredAgentTool | undefined {
  return declarations.get(toolDeclarationIdentity(declaration));
}

/** @internal The issuing Session has been retaining child admission and replies. */
export function createAgentTool<Context, Output>(
  agent: Agent<Context, Output>,
  options: AgentAsToolOptions<Output>,
): FunctionTool<Context> {
  const extract = options.customOutputExtractor;
  const declaration = tool({
    name: options.toolName,
    description: options.toolDescription,
    parameters: z.object({ input: z.string() }),
    execute: ({ input }, context) => invokeConfiguredAgentTool(context, input),
  });
  bindConfiguredAgentRole(declaration, agent.name ?? options.toolName);
  declarations.set(declaration, {
    resultSchema: Object.freeze({ type: 'string' }),
    open: (context, environment, signal, state, verifiedExecutorCheckpoint) => {
      const verifiedState =
        state && verifiedExecutorCheckpoint ? encode(state) : undefined;
      return agent.session(
        ...([
          {
            context,
            signal,
            ...(environment ? { environment } : {}),
            ...(state ? { state } : {}),
            ...(verifiedState === undefined
              ? {}
              : {
                  verifyConfiguredChildExecutorTools: (
                    checkpoint: SessionState,
                  ) => encode(checkpoint) === verifiedState,
                }),
          },
        ] as Parameters<typeof agent.session>),
      );
    },
    async extract(result) {
      if (extract) return extract(result as Completed<Output>);
      return typeof result.finalOutput === 'string'
        ? result.finalOutput
        : encode(jsonValue.parse(result.finalOutput));
    },
  });
  return declaration as FunctionTool<Context>;
}
