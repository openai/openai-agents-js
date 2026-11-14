import type { Agent } from './public-agent';

/** Synchronous application side effects at native Agent lifecycle boundaries. */
export interface AgentLifecycleEvent<Context = unknown> {
  readonly kind: 'start' | 'handoff' | 'end';
  readonly context: Context;
  readonly agent: Agent<Context, unknown>;
  readonly sessionId: string;
  readonly turnId: string;
  readonly subagentId?: string;
  readonly target?: Agent<Context, unknown>;
  readonly output?: unknown;
}

/** The native boundary waits for the synchronous body; listener promises remain unawaited. */
export type AgentLifecycleCallback<Context = unknown> = (
  event: AgentLifecycleEvent<Context>,
) => void;
