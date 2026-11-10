import { toolCompletionSchema, type ToolCallInfo } from './call-metadata';
import { z } from 'zod';
import type { _NativeChildTurn } from '../../native/index.js';
import { decode } from './binding';
import {
  issueTurn,
  TurnAborted,
  type Turn,
  type TurnRequestWait,
  type Completed,
  type PendingRequests,
  type RequestWaitOptions,
  type InteractionWaitOptions,
  type TurnNeedsAttention,
} from './session';
import { NativeError, nativeError, enrichNativeError } from './native-error';
import type { FunctionCallOutput, UserInput } from './input';
import type { ManualToolReply, ManualToolRequest } from './manual';
import type { Interaction } from './native-questions';
import { tokenUsageInfo } from './run-events';
import type { Observation, ObservationOptions } from './observation';
export const subagentSchema = z
  .object({
    id: z.string(),
    object: z.literal('agent.session.subagent'),
    session_id: z.string(),
    parent_agent_id: z.string(),
    name: z.string().nullable(),
    status: z.enum(['active', 'closed']),
    opened_at: z.number().int().safe(),
    closed_at: z.number().int().safe().nullable(),
  })
  .transform(
    ({ session_id, parent_agent_id, opened_at, closed_at, ...rest }) => ({
      ...rest,
      sessionId: session_id,
      parentAgentId: parent_agent_id,
      openedAt: opened_at,
      closedAt: closed_at,
    }),
  );
type SubagentRecord = z.infer<typeof subagentSchema> & { isLive: boolean };

/** @internal Only Session observations can issue a live descendant. */
export let issueSubagent: (
  data: SubagentRecord,
  turn: Turn<string> | null,
  submit: (
    input: UserInput | ManualToolReply | FunctionCallOutput,
  ) => Promise<Turn<string>>,
  tryCancel: (turn: Turn<string>) => Promise<boolean>,
) => Subagent;

/** A child can observe and await its exact native work; controls belong to Subagent. */
export interface ChildTurn extends Pick<
  Turn<string>,
  | 'guardrailResults'
  | 'sessionId'
  | 'turnId'
  | 'submissionId'
  | 'childId'
  | 'instanceId'
  | 'events'
> {
  wait(): Promise<ChildCompleted>;
  wait(
    options: RequestWaitOptions,
  ): Promise<ChildCompleted | ChildPendingRequests<ManualToolRequest>>;
  wait(
    options: RequestWaitOptions | InteractionWaitOptions,
  ): Promise<ChildCompleted | ChildPendingRequests<Interaction>>;
  waitForAttention(options?: {
    signal?: AbortSignal;
  }): Promise<
    ChildCompleted | ChildPendingRequests<Interaction> | TurnNeedsAttention
  >;
}
export type ChildCompleted = Omit<Completed<string>, 'turn'> & {
  readonly turn: ChildTurn;
};
type ChildPendingRequests<RequestT extends Interaction> = Omit<
  PendingRequests<string, string, RequestT>,
  'turn'
> & { readonly turn: ChildTurn };

/** A captured descendant. Reading it never starts or resumes a native runtime. */
export class Subagent {
  readonly id: string;
  readonly sessionId: string;
  readonly parentAgentId: string;
  readonly name: string | null;
  readonly status: 'active' | 'closed';
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly isLive: boolean;
  readonly turn: ChildTurn | null;
  readonly #submit: (
    input: UserInput | ManualToolReply | FunctionCallOutput,
  ) => Promise<Turn<string>>;
  readonly #tryCancel: (turn: Turn<string>) => Promise<boolean>;

  private constructor(
    data: SubagentRecord,
    turn: Turn<string> | null,
    submit: (
      input: UserInput | ManualToolReply | FunctionCallOutput,
    ) => Promise<Turn<string>>,
    tryCancel: (turn: Turn<string>) => Promise<boolean>,
  ) {
    this.id = data.id;
    this.sessionId = data.sessionId;
    this.parentAgentId = data.parentAgentId;
    this.name = data.name;
    this.status = data.status;
    this.openedAt = data.openedAt;
    this.closedAt = data.closedAt;
    this.isLive = data.isLive;
    this.turn = turn;
    this.#submit = submit;
    this.#tryCancel = tryCancel;
    Object.freeze(this);
  }

  static {
    issueSubagent = (data, turn, submit, tryCancel) =>
      new Subagent(data, turn, submit, tryCancel);
  }

  submit(
    input: UserInput | ManualToolReply | FunctionCallOutput,
  ): Promise<ChildTurn> {
    return this.#submit(input);
  }

  /**
   * Try to interrupt this captured child's exact Turn.
   * True confirms native interruption and joined SDK-owned callbacks and cells.
   * False means native cancellation was not confirmed, including pending input.
   * Cleanup continues if the caller stops waiting; uncooperative callbacks can delay it.
   */
  tryCancel(turn: ChildTurn): Promise<boolean> {
    return this.#tryCancel(turn as Turn<string>);
  }
}
export const subagentsSchema = z.array(subagentSchema);

/** @internal Preserve the native receipt while exposing the same Turn as root submissions. */
export function issueChildTurn(
  native: _NativeChildTurn,
  callbacks: {
    beforeWait(): void;
    toolCompletion?(fact: unknown): ToolCallInfo;
    drain(): Promise<void>;
    observations(
      options: ObservationOptions,
    ): AsyncIterableIterator<Observation>;
    requests?: TurnRequestWait<string>;
  },
): Turn<string> {
  let completion: Promise<Completed<string>> | undefined;
  const complete = async (): Promise<Completed<string>> => {
    let wire: string;
    try {
      wire = await native.wait_with_usage();
    } catch (cause) {
      const terminal = native.terminal_error();
      const details = terminal === null ? null : JSON.parse(terminal);
      const message = cause instanceof Error ? cause.message : String(cause);
      const error =
        details?._sdk_child_interrupted === true
          ? new TurnAborted(message, { cause })
          : nativeError(details, message, { cause });
      if (error instanceof TurnAborted) enrichNativeError(error, details);
      throw error;
    } finally {
      await callbacks.drain();
    }
    const result = decode(
      z.object({
        final_output: z.string(),
        usage: z.unknown(),
        tool_completion: toolCompletionSchema.nullish(),
      }),
      wire,
    );
    return Object.freeze({
      turn,
      finalOutput: result.final_output,
      ...(result.tool_completion
        ? { toolCall: callbacks.toolCompletion!(result.tool_completion) }
        : {}),
      threadUsage: tokenUsageInfo(result.usage),
      repairAttempts: Object.freeze([]),
      guardrailResults: turn.guardrailResults,
    });
  };
  const turn: Turn<string> = issueTurn(
    native.session_id,
    native.turn_id,
    `child:${native.child_id}:${native.incarnation}:${native.turn_id}`,
    () => {
      callbacks.beforeWait();
      return (completion ??= complete());
    },
    (options) => callbacks.observations(options),
    () =>
      Promise.reject(new NativeError('Turn.steer supports root Turns only')),
    () =>
      Promise.reject(new NativeError('Turn.cancel supports root Turns only')),
    { childId: native.child_id, instanceId: native.instance_id },
    callbacks.requests,
  );
  return turn;
}
