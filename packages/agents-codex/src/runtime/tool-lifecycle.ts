import type { Agent } from './public-agent';
import type { JsonValue } from './binding';
import type { ToolOutput } from './tools';

/** Synchronous lifecycle of an admitted managed function body. */
export interface ToolLifecycleEvent<Context = unknown> {
  readonly kind: 'start' | 'end';
  readonly context: Context;
  readonly agent: Agent<Context, unknown> | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: Readonly<{ name: string; namespace?: string | null }>;
  /** Original submitted JSON, before approval edits or parameter transformations. */
  readonly arguments: JsonValue;
  readonly signal: AbortSignal;
  readonly status?: 'completed' | 'failed' | 'cancelled';
  /** Detached native output; applicationData remains private to the tool owner. */
  readonly output?: ToolOutput;
}

/** Runs before the body or after its typed result. Returned promises are not awaited. */
export type ToolLifecycleCallback<Context = unknown> = (
  event: ToolLifecycleEvent<Context>,
) => void;
