import { bindConfiguredChildSandboxDefault } from './sandbox-defaults';
import { z } from 'zod';
import type { Agent, Session } from './public-agent';
import type { Environment } from './environment';
import type { Completed, Turn, Session as CoreSession } from './session';
import type { ObservedEvent } from './observation';
import type { ToolCallInfo } from './call-metadata';
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

export interface AgentToolStreamEvent<Output = string> {
  readonly event: ObservedEvent;
  readonly agent: Agent<any, Output>;
  readonly callId: string;
  readonly toolCall?: ToolCallInfo;
}

export interface AgentAsToolOptions<Output = string> {
  toolName: string;
  toolDescription?: string;
  /** Include native produced items in the result passed to customOutputExtractor. */
  returnItems?: boolean;
  /** Observe the child's existing redacted native turn events. Handler errors are isolated. */
  onStream?: (event: AgentToolStreamEvent<Output>) => void | Promise<void>;
  /** Pending events, excluding the active handler. Defaults to 1024; null opts into unbounded retention. */
  onStreamMaxPendingEvents?: number | null;
  customOutputExtractor?: (
    result: Completed<Output>,
  ) => string | Promise<string>;
}

export interface ConfiguredAgentTool {
  readonly returnItems?: boolean;
  readonly resultSchema: { readonly type: 'string' };
  open(
    context: unknown,
    environment: Environment | null,
    signal: AbortSignal,
    state?: SessionState,
    verifiedExecutorCheckpoint?: boolean,
    defaultProviderCompaction?: boolean,
  ): Promise<Session<unknown>>;
  observe?(
    turn: Turn<unknown>,
    session: CoreSession<unknown>,
    initialAgent: Agent<any, any>,
    callId: string,
    toolCall: ToolCallInfo | undefined,
    signal: AbortSignal,
    fail: (error: unknown) => void,
  ): Promise<void>;
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
  const returnItems = options.returnItems === true;
  const extract = options.customOutputExtractor;
  const onStream = options.onStream;
  const maxPending =
    options.onStreamMaxPendingEvents === undefined
      ? 1024
      : options.onStreamMaxPendingEvents;
  if (
    maxPending !== null &&
    (!Number.isSafeInteger(maxPending) || maxPending <= 0)
  )
    throw new TypeError(
      'onStreamMaxPendingEvents must be a positive safe integer or null',
    );
  if (onStream !== undefined && typeof onStream !== 'function')
    throw new TypeError('onStream must be a function');
  const declaration = tool({
    name: options.toolName,
    description: options.toolDescription,
    parameters: z.object({ input: z.string() }),
    execute: ({ input }, context) => invokeConfiguredAgentTool(context, input),
  });
  bindConfiguredAgentRole(declaration, agent.name ?? options.toolName);
  declarations.set(declaration, {
    returnItems,
    resultSchema: Object.freeze({ type: 'string' }),
    open: (
      context,
      environment,
      signal,
      state,
      verifiedExecutorCheckpoint,
      defaultProviderCompaction,
    ) => {
      const verifiedState =
        state && verifiedExecutorCheckpoint ? encode(state) : undefined;
      return agent.session(
        ...([
          bindConfiguredChildSandboxDefault(
            {
              context,
              signal,
              ...(onStream && maxPending === null
                ? { observationRetention: 'all' }
                : {}),
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
            defaultProviderCompaction,
          ),
        ] as Parameters<typeof agent.session>),
      );
    },
    ...(onStream
      ? {
          observe: (
            turn: Turn<unknown>,
            session: CoreSession<unknown>,
            initialAgent: Agent<any, any>,
            callId: string,
            toolCall: ToolCallInfo | undefined,
            signal: AbortSignal,
            fail: (error: unknown) => void,
          ) => {
            let currentAgent = initialAgent;
            return drainConfiguredStream(
              turn.events(),
              (event) => {
                if (event.type === 'agent_profile_changed')
                  currentAgent = session._realtimeConfigurationSource({
                    profile_id: event.profileId,
                    epoch: event.profileEpoch,
                  }).agent;
                return Object.freeze({
                  event,
                  agent: currentAgent,
                  callId,
                  ...(toolCall ? { toolCall } : {}),
                });
              },
              onStream,
              maxPending,
              signal,
              fail,
            );
          },
        }
      : {}),
    async extract(result) {
      if (extract) return extract(result as Completed<Output>);
      return typeof result.finalOutput === 'string'
        ? result.finalOutput
        : encode(jsonValue.parse(result.finalOutput));
    },
  });
  return declaration as FunctionTool<Context>;
}

/** One invocation owns its reader, bounded pending queue and joined active handler. */
async function drainConfiguredStream<T>(
  events: AsyncIterableIterator<ObservedEvent>,
  project: (event: ObservedEvent) => T,
  handler: (event: T) => void | Promise<void>,
  maxPending: number | null,
  signal: AbortSignal,
  fail: (error: unknown) => void,
): Promise<void> {
  let queue: T[] = [];
  let head = 0;
  let ended = false;
  let failed = false;
  let changed = Promise.withResolvers<void>();
  const notify = () => {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  };
  const reject = (error: unknown) => {
    if (failed) return;
    failed = true;
    queue = [];
    head = 0;
    fail(error);
    notify();
  };
  const abort = () => {
    failed = true;
    queue = [];
    head = 0;
    notify();
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const producer = (async () => {
    try {
      for await (const event of events) {
        if (failed) break;
        if (event.type === 'gap') {
          reject(new Error('Configured child stream observation gap'));
          break;
        }
        if (maxPending !== null && queue.length - head >= maxPending) {
          reject(
            new Error(
              'Configured child stream backlog exceeded onStreamMaxPendingEvents',
            ),
          );
          break;
        }
        queue.push(project(event));
        notify();
      }
    } catch (error) {
      reject(error);
    } finally {
      ended = true;
      notify();
    }
  })();
  const consumer = (async () => {
    while (!failed) {
      if (head === queue.length) {
        if (ended) break;
        const pending = changed.promise;
        await pending;
        continue;
      }
      const event = queue[head++];
      if (head >= 1024 && head * 2 >= queue.length) {
        queue = queue.slice(head);
        head = 0;
      }
      // Preserve v0's isolated handler failures while joining every started callback.
      try {
        await handler(event);
      } catch {
        /* Observers do not alter native results. */
      }
    }
  })();
  try {
    await Promise.all([producer, consumer]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
