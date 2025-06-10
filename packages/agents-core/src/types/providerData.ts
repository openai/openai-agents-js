import { HostedMCPApprovalFunction } from '../tool';
import { UnknownContext } from './aliases';

/**
 * OpenAI providerData type definition
 */
export type HostedMCPTool<Context = UnknownContext> = {
  type: 'mcp';
  serverLabel: string;
  serverUrl: string;
} & (
  | { requireApproval?: 'never'; onApproval?: never }
  | {
      requireApproval:
        | 'always'
        | {
            never?: { toolNames: string[] };
            always?: { toolNames: string[] };
          };
      onApproval?: HostedMCPApprovalFunction<Context>;
    }
);

export type HostedMCPListTools = {
  id: string;
  serverLabel: string;
  tools: {
    inputSchema: unknown;
    name: string;
    annotations?: unknown | null;
    description?: string | null;
  }[];
  error?: string | null;
};
export type HostedMCPCall = {
  id: string;
  arguments: string;
  name: string;
  serverLabel: string;
  error?: string | null;
  // excluding this large data field
  // output?: string | null;
};

export type HostedMCPApprovalRequest = {
  id: string;
  name: string;
  arguments: string;
  serverLabel: string;
};

export type HostedMCPApprovalResponse = {
  id?: string;
  approve: boolean;
  approvalRequestId: string;
  reason?: string;
};
