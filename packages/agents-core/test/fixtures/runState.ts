import { Agent, RunContext, RunState } from '../../src';
import type * as protocol from '../../src/types/protocol';

export function hostedApprovalRequest(): protocol.HostedToolCallItem {
  return {
    type: 'hosted_tool_call',
    name: 'mcp_approval_request',
    status: 'completed',
    id: 'mcp-item',
    providerData: {
      type: 'mcp_approval_request',
      server_label: 'demo',
      name: 'remote',
      arguments: '{}',
      id: 'mcp-approval',
    },
  };
}

export function createResumableState<TAgent extends Agent<any, any>>(
  agent: TAgent,
  maxTurns = 3,
) {
  const state = new RunState(new RunContext(), 'initial', agent, maxTurns);
  state._currentTurn = 1;
  state._initialInputGuardrailsCompleted = true;
  state._currentStep = { type: 'next_step_run_again' };
  return state;
}
