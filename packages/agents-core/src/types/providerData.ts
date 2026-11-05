import type OpenAI from 'openai';
import { HostedMCPApprovalFunction } from '../tool';
import { UnknownContext } from './aliases';

/**
 * OpenAI providerData type definition
 */
export type HostedMCPTool<Context = UnknownContext> = {
  type: 'mcp';
  allowed_callers?: Array<'direct' | 'programmatic'>;
  allowed_tools?: string[] | { tool_names: string[] };
  defer_loading?: boolean;
  server_description?: string;
} &
  // MCP server
  (
    | {
        server_label: string;
        server_url?: string;
        authorization?: string;
        headers?: Record<string, string>;
      }
    // OpenAI Connector
    | {
        server_label: string;
        connector_id: string;
        authorization?: string;
        headers?: Record<string, string>;
      }
  ) &
  (
    | { require_approval?: 'never'; on_approval?: never }
    | {
        require_approval:
          | 'always'
          | {
              never?: { tool_names?: string[]; read_only?: boolean };
              always?: { tool_names?: string[]; read_only?: boolean };
            };
        on_approval?: HostedMCPApprovalFunction<Context>;
      }
  );

export type HostedMCPListTools = Pick<
  OpenAI.Responses.ResponseInputItem.McpListTools,
  'id' | 'server_label' | 'tools' | 'error'
>;
export type HostedMCPCall = {
  id: string;
  arguments: string;
  name: string;
  server_label: string;
  connector_id?: string;
  error?: string | null;
  // excluding this large data field
  // output?: string | null;
};

export type HostedMCPApprovalRequest = Pick<
  OpenAI.Responses.ResponseInputItem.McpApprovalRequest,
  'id' | 'name' | 'arguments' | 'server_label'
>;

export type HostedMCPApprovalResponse = {
  id?: string;
  approve: boolean;
  approval_request_id: string;
  reason?: string;
};
