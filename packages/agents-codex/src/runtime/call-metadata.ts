import { bindHostedAgentMetadata } from './hosted-agent-metadata';
import { z } from 'zod';
import { jsonObject, type JsonObject } from './binding';
import type { ToolCallContext } from './tools';

/** Observed call identity. These values never grant execution or reply authority. */
export interface ToolCallInfo {
  readonly tool: Readonly<{ name: string; namespace: string | null }>;
  readonly sessionId: string;
  readonly turnId: string;
  /** Provider call ID; generated function/manual calls have no provider ID. */
  readonly callId: string | null;
  readonly childId: string | null;
  readonly childIncarnation: string | null;
  readonly role: string | null;
  readonly model: string | null;
  readonly route: 'direct' | 'code';
  readonly outerCallId: string | null;
  readonly cellId: string | null;
  readonly nestedCallId: string | null;
}

type Owner = Pick<ToolCallInfo, 'sessionId' | 'childId' | 'childIncarnation'>;

function freezeCall(call: ToolCallInfo): ToolCallInfo {
  return Object.freeze({ ...call, tool: Object.freeze({ ...call.tool }) });
}

const codeOrigin = z.union([
  z.null(),
  z.object({ cell_id: z.string(), nested_call_id: z.string() }),
]);

/** @internal Called after the managed request's owner and declaration match. */
export function managedCallInfo(
  owner: Owner,
  message: JsonObject,
): ToolCallInfo {
  // Live and restored requests explicitly project source. Never treat a missing
  // source as proof that an invocation ID came from the provider.
  const source = codeOrigin.parse(message._sdk_code_origin);
  return bindHostedAgentMetadata(
    freezeCall({
      ...owner,
      tool: {
        name: message.tool as string,
        namespace: (message.namespace as string | null) ?? null,
      },
      turnId: message.turnId as string,
      callId: source === null ? (message.callId as string) : null,
      role: null,
      model: (message._sdk_model as string | null) ?? null,
      route: source === null ? 'direct' : 'code',
      outerCallId: null,
      cellId: source?.cell_id ?? null,
      nestedCallId: source?.nested_call_id ?? null,
    }),
    source === null ? message._sdk_hosted_agent_metadata : undefined,
  );
}

/** @internal The dispatcher supplies the already matched callback submission. */
export function interceptedCallInfo(
  submission: ToolCallContext['submission'],
  request: JsonObject,
): ToolCallInfo {
  const tool = jsonObject.parse(request.tool_name);
  return freezeCall({
    sessionId: submission.sessionId,
    childId: submission.childId ?? null,
    // A public child Turn.instanceId is Core's instance counter. The matched
    // interception request carries the separate native incarnation.
    childIncarnation: submission.childId
      ? ((request.incarnation as string | null) ?? null)
      : null,
    tool: {
      name: tool.name as string,
      namespace: (tool.namespace as string | null) ?? null,
    },
    turnId: request.turn_id as string,
    callId: (request.call_id as string | null) ?? null,
    role: (request.agent_role as string | null) ?? null,
    model: (request.model as string | null) ?? null,
    route: request.route === 'code_mode' ? 'code' : 'direct',
    outerCallId: (request.outer_call_id as string | null) ?? null,
    cellId: (request.cell_id as string | null) ?? null,
    nestedCallId: (request.runtime_tool_call_id as string | null) ?? null,
  });
}

/** Canonical terminal facts are observations, never live call authority. */
export const toolCompletionSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  namespace: z.string().nullable().optional(),
  final_output: z.unknown(),
  batch_call_ids: z.array(z.string()).nonempty().optional(),
});

/** @internal Use only after the exact runtime and terminal proposal match. */
export function terminalCallInfo(
  owner: Owner & { turnId: string },
  fact: z.infer<typeof toolCompletionSchema>,
  namespace: string | null = fact.namespace ?? null,
): ToolCallInfo {
  return freezeCall({
    ...owner,
    tool: { name: fact.name, namespace },
    callId: fact.call_id,
    role: null,
    model: null,
    route: 'direct',
    outerCallId: null,
    cellId: null,
    nestedCallId: null,
  });
}
