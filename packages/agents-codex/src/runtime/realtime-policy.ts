import { abortable } from '../voice/abortable';
import type { Agent } from './public-agent';
import type {
  NativeRealtimeUsage,
  NativeRealtimeUsageAccounting,
} from './realtime-usage';

/** Application context for one captured native voice profile. */
export interface NativeRealtimePolicyContext<Context = unknown> {
  readonly agent: Agent<Context, any>;
  readonly context: Context;
  readonly realtimeUsage?: NativeRealtimeUsage;
  readonly realtimeUsageAccounting?: NativeRealtimeUsageAccounting;
  readonly signal?: AbortSignal;
}

/** A captured declaration; predicates can narrow, never add, native tools. */
export interface NativeRealtimeTool {
  readonly type: 'function' | 'handoff';
  readonly name: string;
}

/** @internal Policies only narrow captured declarations; Core checks the receipt atomically. */
export async function resolveRealtimePolicy(
  session: import('./session').Session<any, any>,
  options: Pick<
    import('./realtime').NativeRealtimeOptions,
    'instructions' | 'isToolEnabled'
  >,
  signal: AbortSignal | undefined,
  check: () => void,
  realtimeUsage?: NativeRealtimeUsage,
  snapshot?: Awaited<
    ReturnType<import('./session').Session['_realtimeSourceSnapshot']>
  >,
  realtimeUsageAccounting?: NativeRealtimeUsageAccounting,
) {
  const instructions = options.instructions;
  const enabled = options.isToolEnabled;
  if (typeof instructions !== 'function' && enabled === undefined)
    return {
      instructions,
      disabledToolNames: undefined,
      selectionId: undefined,
    };
  const source = await session._realtimePolicySource(snapshot);
  signal?.throwIfAborted();
  check();
  const context = Object.freeze({
    agent: source.agent,
    context: source.context,
    realtimeUsage,
    realtimeUsageAccounting,
    signal,
  });
  let resolved: string | undefined;
  let disabledToolNames: string[] | undefined;
  await session._runVoiceCallback(async () => {
    resolved =
      typeof instructions === 'function'
        ? await abortable(Promise.resolve(instructions(context)), signal)
        : instructions;
    signal?.throwIfAborted();
    check();
    if (typeof instructions === 'function' && typeof resolved !== 'string')
      throw new TypeError(
        'Realtime instructions callback must return a string',
      );
    if (enabled !== undefined) {
      disabledToolNames = [];
      for (const tool of source.tools) {
        const accepted = await abortable(
          Promise.resolve(enabled(context, Object.freeze(tool))),
          signal,
        );
        signal?.throwIfAborted();
        check();
        if (typeof accepted !== 'boolean')
          throw new TypeError('Realtime tool predicate must return a boolean');
        if (!accepted) disabledToolNames.push(tool.name);
      }
    }
  });
  return {
    instructions: resolved,
    disabledToolNames,
    selectionId: source.selectionId,
  };
}

/** Formatter input for a managed native function approval rejection. */
export interface NativeRealtimeToolErrorContext {
  readonly kind: 'approval_rejected';
  readonly toolType: 'function';
  readonly toolName: string;
  readonly callId: string;
  readonly defaultMessage: string;
  readonly runContext: NativeRealtimePolicyContext;
}
