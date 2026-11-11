import { hostedMcpTool as providerHostedMcp } from '@openai/agents-core';
import { z } from 'zod';
import { losslessJsonValueSchema, type JsonValue } from './binding';
import { HostedMcpBinding, bindHostedMcp } from './hosted-mcp-binding';
import { manualTool, type ManualTool } from './manual';
import {
  tool,
  type FunctionTool,
  type ToolContext,
  type ToolRef,
} from './tools';

export interface HostedMCPApprovalArguments {
  readonly serverLabel: string;
  readonly name: string;
  readonly arguments: string;
  readonly caller?: JsonValue;
}

export interface HostedMCPApprovalRequest<
  Context = unknown,
> extends HostedMCPApprovalArguments {
  readonly context: ToolContext<Context>;
  readonly requestId: string;
}

export interface HostedMCPApprovalDecision {
  readonly approve: boolean;
  readonly reason?: string | null;
}

type WithoutCallback<T> = T extends unknown ? Omit<T, 'onApproval'> : never;
type ProviderOptions = WithoutCallback<Parameters<typeof providerHostedMcp>[0]>;
type ApprovalCallback<Context> = (
  request: HostedMCPApprovalRequest<Context>,
) => HostedMCPApprovalDecision | Promise<HostedMCPApprovalDecision>;

export type HostedMCPOptions<Context = unknown> = ProviderOptions & {
  onApprovalRequest?: ApprovalCallback<Context>;
};
export type HostedMCPFunction<Context = unknown> = FunctionTool<Context> & {
  readonly ref: ToolRef;
};
export type HostedMCPManual = ManualTool<
  HostedMCPApprovalArguments,
  HostedMCPApprovalDecision
> & { readonly ref: ToolRef };

const decisionSchema = z
  .object({ approve: z.boolean(), reason: z.string().nullable().optional() })
  .strict();

export function hostedMcp<Context>(
  options: HostedMCPOptions<Context> & {
    onApprovalRequest: ApprovalCallback<Context>;
  },
): HostedMCPFunction<Context>;
export function hostedMcp<Context = unknown>(
  options: HostedMCPOptions<Context> & {
    requireApproval?: 'never';
    onApprovalRequest?: undefined;
  },
): HostedMCPFunction<Context>;
export function hostedMcp(
  options: HostedMCPOptions & {
    requireApproval: Exclude<
      NonNullable<ProviderOptions['requireApproval']>,
      'never'
    >;
    onApprovalRequest?: undefined;
  },
): HostedMCPManual;
export function hostedMcp<Context = unknown>(
  options: HostedMCPOptions<Context>,
): HostedMCPFunction<Context> | HostedMCPManual;
/** Provider-hosted MCP with scoped native approval replies and the existing never default. */
export function hostedMcp<Context = unknown>(
  options: HostedMCPOptions<Context>,
): HostedMCPFunction<Context> | HostedMCPManual {
  if ('onApproval' in options)
    throw new TypeError('Native Hosted MCP uses onApprovalRequest');
  const { onApprovalRequest, ...providerOptions } = options;
  if (
    onApprovalRequest !== undefined &&
    typeof onApprovalRequest !== 'function'
  )
    throw new TypeError('onApprovalRequest must be a function');
  const configuration = providerHostedMcp(providerOptions).providerData;
  const binding = new HostedMcpBinding(configuration);
  const parameters = z
    .object({
      server_label: z.string().min(1),
      name: z.string().min(1),
      arguments: z.string(),
      caller: losslessJsonValueSchema.optional(),
    })
    .superRefine((request, context) => {
      if (
        request.server_label !== binding.serverLabel ||
        !binding.admitsTool(request.name) ||
        !binding.admitsCaller(request.caller)
      )
        context.addIssue({
          code: 'custom',
          message: 'Unadmitted Hosted MCP request',
        });
    })
    .transform((request) => ({
      serverLabel: request.server_label,
      name: request.name,
      arguments: request.arguments,
      ...(request.caller === undefined ? {} : { caller: request.caller }),
    }));
  const declaration = {
    name: binding.serverLabel,
    description:
      'Approve a request from the configured provider-hosted MCP server',
    parameters,
  };
  if (onApprovalRequest)
    return bindHostedMcp(
      tool({
        ...declaration,
        namespace: 'hosted_mcp',
        execute: async (args, context: ToolContext<Context>) =>
          decisionSchema.parse(
            await onApprovalRequest({
              ...args,
              context,
              requestId: context.callId,
            }),
          ),
      }),
      binding,
    );
  if (!binding.requiresApproval)
    return bindHostedMcp(
      tool({
        ...declaration,
        namespace: 'hosted_mcp',
        execute: (_args, _context: ToolContext<Context>) => {
          throw new TypeError(
            'Provider requested approval for a never-approval Hosted MCP server',
          );
        },
      }),
      binding,
    );
  return bindHostedMcp(
    manualTool({ ...declaration, result: decisionSchema }),
    binding,
  );
}
