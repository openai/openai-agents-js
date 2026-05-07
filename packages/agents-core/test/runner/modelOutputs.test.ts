import { beforeAll, describe, expect, it, vi } from 'vitest';

import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { Agent } from '../../src/agent';
import { ModelBehaviorError, UserError } from '../../src/errors';
import { handoff } from '../../src/handoff';
import {
  RunHandoffCallItem as HandoffCallItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  RunToolSearchCallItem as ToolSearchCallItem,
  RunToolSearchOutputItem as ToolSearchOutputItem,
} from '../../src/items';
import { ModelResponse } from '../../src/model';
import {
  processModelResponse,
  processModelResponseAsync,
} from '../../src/runner/modelOutputs';
import { RunContext } from '../../src/runContext';
import { RunState } from '../../src/runState';
import {
  attachClientToolSearchExecutor,
  computerTool,
  applyPatchTool,
  hostedMcpTool,
  shellTool,
  tool,
  toolNamespace,
} from '../../src/tool';
import {
  FUNCTION_TOOL_NAMESPACE,
  FUNCTION_TOOL_NAMESPACE_DESCRIPTION,
} from '../../src/toolIdentity';
import { Usage } from '../../src/usage';
import {
  FakeEditor,
  FakeModelProvider,
  FakeShell,
  TEST_AGENT,
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
  TEST_TOOL,
} from '../stubs';
import * as protocol from '../../src/types/protocol';
import { z } from 'zod';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

function createLegacyNamespacedTool<T extends Record<string, any>>(
  tool: T,
  namespace: string,
  description: string,
): T {
  return Object.defineProperties(tool, {
    [FUNCTION_TOOL_NAMESPACE]: {
      value: namespace,
      enumerable: false,
      configurable: true,
    },
    [FUNCTION_TOOL_NAMESPACE_DESCRIPTION]: {
      value: description,
      enumerable: false,
      configurable: true,
    },
  });
}

describe('processModelResponse', () => {
  it('processes message outputs and tool calls', () => {
    const modelResponse: ModelResponse = TEST_MODEL_RESPONSE_WITH_FUNCTION;

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );

    expect(result.newItems).toHaveLength(2);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.newItems[0].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    );
    expect(result.toolsUsed).toEqual(['test']);
    expect(result.functions).toContainEqual({
      tool: TEST_TOOL,
      toolCall: TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    });
    expect(result.newItems[1]).toBeInstanceOf(MessageOutputItem);
    expect(result.newItems[1].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[1],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('classifies tool search items as run items and records tool usage', () => {
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: ['crm'],
            query: 'profile',
          },
        },
        {
          type: 'tool_search_output',
          id: 'ts_output',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(modelResponse, TEST_AGENT, [], []);

    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.newItems[1]).toBeInstanceOf(ToolSearchOutputItem);
    expect(result.toolsUsed).toEqual(['tool_search']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('auto-executes built-in client tool_search calls for deferred tools', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const shippingCredit = tool({
      name: 'get_shipping_credit_balance',
      description: 'Look up a shipping credit balance.',
      parameters: z.object({
        customerId: z.string(),
      }),
      deferLoading: true,
      execute: async () => 125,
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: ['get_shipping_eta', 'missing_tool', 'get_shipping_eta'],
            query: 'shipping ETA',
          },
          providerData: {
            call_id: 'call_ts_1',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [shippingEta, shippingCredit],
      [],
    );

    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.newItems[1]).toBeInstanceOf(ToolSearchOutputItem);
    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      status: 'completed',
      tools: [
        {
          type: 'function',
          name: 'get_shipping_eta',
          description: 'Look up a shipping ETA.',
          deferLoading: true,
        },
      ],
      providerData: {
        call_id: 'call_ts_1',
        execution: 'client',
      },
    });
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('auto-executes built-in client tool_search calls for deferred namespaces', () => {
    const crmTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => 'account',
        }),
        tool({
          name: 'list_recent_tickets',
          description: 'List recent tickets.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => ['ticket'],
        }),
        tool({
          name: 'ping',
          description: 'Immediate CRM ping.',
          parameters: z.object({}),
          execute: async () => 'pong',
        }),
      ],
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: ['crm', 'missing_tool', 'crm'],
            query: 'crm tools',
          },
          providerData: {
            call_id: 'call_ts_namespace',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      crmTools,
      [],
    );

    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.newItems[1]).toBeInstanceOf(ToolSearchOutputItem);
    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      status: 'completed',
      tools: [
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools.',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              description: 'Look up an account.',
              deferLoading: true,
            },
            {
              type: 'function',
              name: 'list_recent_tickets',
              description: 'List recent tickets.',
              deferLoading: true,
            },
          ],
        },
      ],
      providerData: {
        call_id: 'call_ts_namespace',
        execution: 'client',
      },
    });
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('auto-executes built-in client tool_search calls for deferred namespace members', () => {
    const crmTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => 'account',
        }),
        tool({
          name: 'list_recent_tickets',
          description: 'List recent tickets.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => ['ticket'],
        }),
      ],
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: ['crm.lookup_account'],
            query: 'account lookup',
          },
          providerData: {
            call_id: 'call_ts_member',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      crmTools,
      [],
    );

    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      status: 'completed',
      tools: [
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools.',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              description: 'Look up an account.',
              deferLoading: true,
            },
          ],
        },
      ],
      providerData: {
        call_id: 'call_ts_member',
        execution: 'client',
      },
    });
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('coalesces multiple deferred namespace members into a single namespace output', () => {
    const crmTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => 'account',
        }),
        tool({
          name: 'list_recent_tickets',
          description: 'List recent tickets.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => ['ticket'],
        }),
      ],
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: [
              'crm.lookup_account',
              'crm.list_recent_tickets',
              'crm.lookup_account',
            ],
          },
          providerData: {
            call_id: 'call_ts_member_batch',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      crmTools,
      [],
    );

    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      status: 'completed',
      tools: [
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools.',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              description: 'Look up an account.',
              deferLoading: true,
            },
            {
              type: 'function',
              name: 'list_recent_tickets',
              description: 'List recent tickets.',
              deferLoading: true,
            },
          ],
        },
      ],
      providerData: {
        call_id: 'call_ts_member_batch',
        execution: 'client',
      },
    });
  });

  it('auto-executes built-in client tool_search calls for deferred hosted MCP servers', () => {
    const shopify = hostedMcpTool({
      serverLabel: 'shopify',
      serverUrl: 'https://mcp.example.com/shopify',
      serverDescription: 'Orders and customer records.',
      deferLoading: true,
      requireApproval: 'always',
    });
    const clientToolSearch = {
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        execution: 'client',
      },
    } as any;
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call_mcp',
          status: 'completed',
          arguments: {
            paths: ['shopify'],
            query: 'shopify tools',
          },
          providerData: {
            call_id: 'call_ts_mcp',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [clientToolSearch, shopify],
      [],
    );

    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      status: 'completed',
      tools: [
        {
          type: 'mcp',
          server_label: 'shopify',
          server_url: 'https://mcp.example.com/shopify',
          server_description: 'Orders and customer records.',
          defer_loading: true,
          require_approval: 'always',
        },
      ],
      providerData: {
        call_id: 'call_ts_mcp',
        execution: 'client',
      },
    });
  });

  it('preserves the original hosted MCP tool when prior search results match it', () => {
    const onApproval = vi.fn(async () => ({ approve: true }));
    const shopify = hostedMcpTool({
      serverLabel: 'shopify',
      serverUrl: 'https://mcp.example.com/shopify',
      serverDescription: 'Orders and customer records.',
      deferLoading: true,
      requireApproval: 'always',
      onApproval,
    });
    const priorItems = [
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_shopify',
          status: 'completed',
          tools: [
            {
              type: 'mcp',
              server_label: 'shopify',
              server_url: 'https://mcp.example.com/shopify',
              server_description: 'Orders and customer records.',
              defer_loading: true,
              require_approval: 'always',
            },
          ],
        } as any,
        TEST_AGENT,
      ),
    ];
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'hosted_tool_call',
          id: 'approval-1',
          name: 'mcp_approval_request',
          status: 'completed',
          providerData: {
            type: 'mcp_approval_request',
            server_label: 'shopify',
            name: 'list_orders',
            id: 'approval-1',
            arguments: '{}',
          },
        } as any,
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [shopify],
      [],
      priorItems,
    );

    expect(result.mcpApprovalRequests).toHaveLength(1);
    expect(result.mcpApprovalRequests[0].mcpTool).toBe(shopify);
    expect(result.mcpApprovalRequests[0].mcpTool.providerData.on_approval).toBe(
      onApproval,
    );
  });

  it('rejects ambiguous built-in client tool_search paths that match both a deferred tool and a namespace', () => {
    const topLevelCrm = tool({
      name: 'crm',
      description: 'Top-level CRM loader.',
      parameters: z.object({}),
      deferLoading: true,
      execute: async () => 'top-level crm',
    });
    const crmTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account.',
          parameters: z.object({
            customerId: z.string(),
          }),
          deferLoading: true,
          execute: async () => 'account',
        }),
      ],
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            paths: ['crm'],
            query: 'crm tools',
          },
          providerData: {
            call_id: 'call_ts_namespace_ambiguous',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(
        modelResponse,
        TEST_AGENT,
        [topLevelCrm, ...crmTools],
        [],
      ),
    ).toThrow(/cannot disambiguate built-in client tool_search path "crm"/);
  });

  it('throws when asked to auto-execute custom client tool_search schemas', () => {
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: { namespaceHints: ['crm'] },
          providerData: {
            call_id: 'call_ts_1',
            execution: 'client',
          },
        },
      ],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [], []),
    ).toThrow(UserError);
    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [], []),
    ).toThrow(/only auto-execute built-in client tool_search calls/);
  });

  it('auto-executes custom client tool_search callbacks before later function calls in the same response', async () => {
    const lookupAccount = tool({
      name: 'lookup_account',
      description: 'Look up an account.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'account',
    });
    const execute = vi.fn().mockResolvedValue(lookupAccount);
    const clientToolSearch = attachClientToolSearchExecutor(
      {
        type: 'hosted_tool',
        name: 'tool_search',
        providerData: {
          type: 'tool_search',
          execution: 'client',
          parameters: {
            type: 'object',
            properties: {
              namespaceHints: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['namespaceHints'],
            additionalProperties: false,
          },
        },
      },
      execute,
    );
    const toolSearchCall: protocol.ToolSearchCallItem = {
      type: 'tool_search_call',
      id: 'ts_call_lookup',
      status: 'completed',
      arguments: {
        namespaceHints: ['crm'],
      },
      providerData: {
        call_id: 'call_tool_search_lookup',
        execution: 'client',
      },
    } as any;
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_lookup_account',
      callId: 'call_lookup_account',
      name: 'lookup_account',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [toolSearchCall, functionCall],
      usage: new Usage(),
    };
    const agent = new Agent({
      name: 'CustomClientToolSearchAgent',
    });
    const state = new RunState(new RunContext(), 'hello', agent, 3);

    const result = await processModelResponseAsync(
      modelResponse,
      agent,
      [clientToolSearch],
      [],
      state,
      [],
    );

    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_search_call_item',
      'tool_search_output_item',
      'tool_call_item',
    ]);
    expect(result.functions).toEqual([
      {
        toolCall: functionCall,
        tool: lookupAccount,
      },
    ]);
    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      providerData: {
        call_id: 'call_tool_search_lookup',
        execution: 'client',
      },
      tools: [
        {
          type: 'function',
          name: 'lookup_account',
        },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.getToolSearchRuntimeTools(agent)).toEqual([lookupAccount]);
  });

  it('does not auto-execute tool_search calls that explicitly request server execution', () => {
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          execution: 'server',
          status: 'completed',
          arguments: { namespaceHints: ['crm'] },
        } as any,
      ],
      usage: new Usage(),
    };
    const clientToolSearch = {
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        execution: 'client',
      },
    } as any;

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [clientToolSearch], []),
    ).not.toThrow();

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [clientToolSearch],
      [],
    );

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('does not let server tool_search outputs without call_id resolve pending client searches', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call_client',
          status: 'completed',
          arguments: {
            paths: ['get_shipping_eta'],
          },
          providerData: {
            execution: 'client',
          },
        },
        {
          type: 'tool_search_output',
          id: 'ts_output_server',
          execution: 'server',
          status: 'completed',
          tools: [],
        } as any,
      ],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [shippingEta],
      [],
    );

    expect(result.newItems).toHaveLength(3);
    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.newItems[1]).toBeInstanceOf(ToolSearchOutputItem);
    expect(result.newItems[2]).toBeInstanceOf(ToolSearchOutputItem);
    expect((result.newItems[1] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      providerData: {
        execution: 'client',
      },
      tools: [
        {
          type: 'function',
          name: 'get_shipping_eta',
        },
      ],
    });
    expect((result.newItems[2] as ToolSearchOutputItem).rawItem).toMatchObject({
      type: 'tool_search_output',
      execution: 'server',
      tools: [],
    });
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('reads top-level execution and call_id on raw SDK tool_search items', () => {
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call_a',
          call_id: 'call_ts_a',
          execution: 'client',
          status: 'completed',
          arguments: { namespaceHints: ['crm'] },
        } as any,
        {
          type: 'tool_search_call',
          id: 'ts_call_b',
          call_id: 'call_ts_b',
          execution: 'client',
          status: 'completed',
          arguments: { namespaceHints: ['billing'] },
        } as any,
        {
          type: 'tool_search_output',
          id: 'ts_output_b',
          call_id: 'call_ts_b',
          execution: 'client',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_invoice',
              namespace: 'billing',
            },
          ],
        } as any,
      ],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [], []),
    ).toThrow(/call_ts_a/);
    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [], []),
    ).not.toThrow(/call_ts_b/);
  });

  it('resolves completed client tool_search calls without explicit call_id', () => {
    const modelResponse: ModelResponse = {
      output: [
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: { namespaceHints: ['crm'] },
          providerData: {
            execution: 'client',
          },
        },
        {
          type: 'tool_search_output',
          id: 'ts_output',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'crm',
            },
          ],
        },
      ],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [], []),
    ).not.toThrow();
    const result = processModelResponse(modelResponse, TEST_AGENT, [], []);
    expect(result.newItems[0]).toBeInstanceOf(ToolSearchCallItem);
    expect(result.newItems[1]).toBeInstanceOf(ToolSearchOutputItem);
  });

  it('uses namespace-qualified names to resolve duplicate function tools', () => {
    const crmLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account in CRM.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'crm',
    });
    const billingLookup = tool({
      name: 'lookup_account',
      description: 'Look up an account in billing.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'billing',
    });
    const crmNamespace = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [crmLookup],
    });
    const billingNamespace = toolNamespace({
      name: 'billing',
      description: 'Billing tools',
      tools: [billingLookup],
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_namespace',
      callId: 'call_namespace',
      name: 'lookup_account',
      namespace: 'billing',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [...crmNamespace, ...billingNamespace],
      [],
    );

    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]).toEqual({
      toolCall: functionCall,
      tool: billingNamespace[0],
    });
    expect(result.toolsUsed).toEqual(['billing.lookup_account']);
  });

  it('rejects top-level deferred tool calls before tool_search loads them', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_eta',
      callId: 'call_shipping_eta',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      status: 'completed',
      arguments: '{"trackingNumber":"ZX-123"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [shippingEta], []),
    ).toThrow(
      /deferred function call get_shipping_eta before it was loaded via tool_search/,
    );
  });

  it('falls back to the bare tool name for top-level deferred tool calls after tool_search loads them', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_eta',
      callId: 'call_shipping_eta',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      status: 'completed',
      arguments: '{"trackingNumber":"ZX-123"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };
    const priorItems = [
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_shipping_eta',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
              namespace: 'get_shipping_eta',
            },
          ],
        } as any,
        TEST_AGENT,
      ),
    ];

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [shippingEta],
      [],
      priorItems,
    );

    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]).toEqual({
      toolCall: functionCall,
      tool: shippingEta,
    });
    expect(result.toolsUsed).toEqual(['get_shipping_eta']);
  });

  it('does not treat tool_search outputs from other agents as loaded for the current agent', () => {
    const otherAgent = new Agent({ name: 'OtherAgent' });
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_eta',
      callId: 'call_shipping_eta',
      name: 'get_shipping_eta',
      namespace: 'get_shipping_eta',
      status: 'completed',
      arguments: '{"trackingNumber":"ZX-123"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };
    const priorItems = [
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_other_agent',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
              namespace: 'get_shipping_eta',
            },
          ],
        } as any,
        otherAgent,
      ),
    ];

    expect(() =>
      processModelResponse(
        modelResponse,
        TEST_AGENT,
        [shippingEta],
        [],
        priorItems,
      ),
    ).toThrow(
      /deferred function call get_shipping_eta before it was loaded via tool_search/,
    );
  });

  it('treats later tool_search outputs with the same call_id as replacements for loaded deferred tools', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const shippingCredit = tool({
      name: 'get_shipping_credit_balance',
      description: 'Look up a shipping credit balance.',
      parameters: z.object({
        customerId: z.string(),
      }),
      deferLoading: true,
      execute: async () => 125,
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_credit',
      callId: 'call_shipping_credit',
      name: 'get_shipping_credit_balance',
      namespace: 'get_shipping_credit_balance',
      status: 'completed',
      arguments: '{"customerId":"cust_123"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };
    const priorItems = [
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_shipping_full',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
              namespace: 'get_shipping_eta',
            },
            {
              type: 'tool_reference',
              functionName: 'get_shipping_credit_balance',
              namespace: 'get_shipping_credit_balance',
            },
          ],
          providerData: {
            call_id: 'call_ts_shipping',
          },
        } as any,
        TEST_AGENT,
      ),
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_shipping_eta_only',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
              namespace: 'get_shipping_eta',
            },
          ],
          providerData: {
            call_id: 'call_ts_shipping',
          },
        } as any,
        TEST_AGENT,
      ),
    ];

    expect(() =>
      processModelResponse(
        modelResponse,
        TEST_AGENT,
        [shippingEta, shippingCredit],
        [],
        priorItems,
      ),
    ).toThrow(
      /deferred function call get_shipping_credit_balance before it was loaded via tool_search/,
    );
  });

  it('auto-loads built-in client tool_search results before later deferred tool calls in the same response', () => {
    const shippingEta = tool({
      name: 'get_shipping_eta',
      description: 'Look up a shipping ETA.',
      parameters: z.object({
        trackingNumber: z.string(),
      }),
      deferLoading: true,
      execute: async () => 'tomorrow',
    });
    const toolSearchCall: protocol.ToolSearchCallItem = {
      type: 'tool_search_call',
      id: 'ts_call_shipping_eta',
      status: 'completed',
      arguments: {
        paths: ['get_shipping_eta'],
      },
      providerData: {
        execution: 'client',
      },
    } as any;
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_shipping_eta',
      callId: 'call_shipping_eta',
      name: 'get_shipping_eta',
      status: 'completed',
      arguments: '{"trackingNumber":"ZX-123"}',
    };
    const modelResponse: ModelResponse = {
      output: [toolSearchCall, functionCall],
      usage: new Usage(),
    };
    const clientToolSearch = {
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        execution: 'client',
      },
    } as any;

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [clientToolSearch, shippingEta],
      [],
    );

    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_search_call_item',
      'tool_search_output_item',
      'tool_call_item',
    ]);
    expect(result.functions).toEqual([
      {
        toolCall: functionCall,
        tool: shippingEta,
      },
    ]);
  });

  it('prefers namespaced function tools over bare-name handoffs', () => {
    const target = new Agent({ name: 'EscalationTarget' });
    const h = handoff(target, {
      toolNameOverride: 'lookup_account',
    });
    const crmLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account in CRM.',
          parameters: z.object({
            accountId: z.string(),
          }),
          execute: async () => 'crm',
        }),
      ],
    })[0];
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_crm_lookup',
      callId: 'call_crm_lookup',
      name: 'lookup_account',
      namespace: 'crm',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [crmLookup],
      [h],
    );

    expect(result.functions).toEqual([
      {
        toolCall: {
          ...functionCall,
          name: 'lookup_account',
          namespace: 'crm',
        },
        tool: crmLookup,
      },
    ]);
    expect(result.handoffs).toEqual([]);
    expect(result.toolsUsed).toEqual(['crm.lookup_account']);
  });

  it('prefers real same-name namespaces over bare top-level tools', () => {
    const topLevelLookup = tool({
      name: 'lookup_account',
      description: 'Look up a top-level account.',
      parameters: z.object({
        accountId: z.string(),
      }),
      execute: async () => 'top-level',
    });
    const namespacedLookup = createLegacyNamespacedTool(
      tool({
        name: 'lookup_account',
        description: 'Look up an account in a matching namespace.',
        parameters: z.object({
          accountId: z.string(),
        }),
        deferLoading: true,
        execute: async () => 'namespaced',
      }),
      'lookup_account',
      'Nested lookup tools',
    );
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_same_name_namespace',
      callId: 'call_same_name_namespace',
      name: 'lookup_account',
      namespace: 'lookup_account',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };
    const priorItems = [
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output_same_name_namespace',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'lookup_account',
              namespace: 'lookup_account',
            },
          ],
        } as any,
        TEST_AGENT,
      ),
    ];

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [topLevelLookup, namespacedLookup],
      [],
      priorItems,
    );

    expect(result.functions).toEqual([
      {
        toolCall: functionCall,
        tool: namespacedLookup,
      },
    ]);
    expect(result.toolsUsed).toEqual(['lookup_account.lookup_account']);
  });

  it('rejects ambiguous dotted handoff overrides that clash with namespace tools', () => {
    const target = new Agent({ name: 'EscalationTarget' });
    const h = handoff(target, {
      toolNameOverride: 'crm.lookup_account',
    });
    const crmLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account in CRM.',
          parameters: z.object({
            accountId: z.string(),
          }),
          execute: async () => 'crm',
        }),
      ],
    })[0];
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_crm_lookup',
      callId: 'call_crm_lookup',
      name: 'crm.lookup_account',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [crmLookup], [h]),
    ).toThrow(
      /Ambiguous dotted tool call crm\.lookup_account in agent TestAgent: it matches both a namespaced function tool and a handoff/,
    );
  });

  it('still resolves dotted handoff overrides when no matching function tool exists', () => {
    const target = new Agent({ name: 'EscalationTarget' });
    const h = handoff(target, {
      toolNameOverride: 'crm.lookup_account',
    });
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_crm_lookup',
      callId: 'call_crm_lookup',
      name: 'crm.lookup_account',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    const result = processModelResponse(modelResponse, TEST_AGENT, [], [h]);

    expect(result.functions).toEqual([]);
    expect(result.handoffs).toEqual([
      {
        toolCall: functionCall,
        handoff: h,
      },
    ]);
    expect(result.toolsUsed).toEqual(['crm.lookup_account']);
  });

  it('still resolves explicit namespace function calls when a dotted handoff override shares the qualified name', () => {
    const target = new Agent({ name: 'EscalationTarget' });
    const h = handoff(target, {
      toolNameOverride: 'crm.lookup_account',
    });
    const crmLookup = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account in CRM.',
          parameters: z.object({
            accountId: z.string(),
          }),
          execute: async () => 'crm',
        }),
      ],
    })[0];
    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_crm_lookup_explicit_namespace',
      callId: 'call_crm_lookup_explicit_namespace',
      name: 'lookup_account',
      namespace: 'crm',
      status: 'completed',
      arguments: '{"accountId":"acct_42"}',
    };
    const modelResponse: ModelResponse = {
      output: [functionCall],
      usage: new Usage(),
    };

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [crmLookup],
      [h],
    );

    expect(result.functions).toEqual([
      {
        toolCall: functionCall,
        tool: crmLookup,
      },
    ]);
    expect(result.handoffs).toEqual([]);
    expect(result.toolsUsed).toEqual(['crm.lookup_account']);
  });

  it('queues shell actions when shell tool registered', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({ shell: new FakeShell() });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.shellActions).toHaveLength(1);
    expect(result.shellActions[0]?.toolCall).toEqual(shellCall);
    expect(result.shellActions[0]?.shell).toBe(shell);
    expect(result.toolsUsed).toEqual(['shell']);
  });

  it('treats shell tools without environment as local for backward compatibility', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const legacyShellTool = {
      type: 'shell',
      name: 'shell',
      shell: new FakeShell(),
      needsApproval: async () => false,
    } as any;

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [legacyShellTool],
      [],
    );

    expect(result.shellActions).toHaveLength(1);
    expect(result.shellActions[0]?.toolCall).toEqual(shellCall);
    expect(result.shellActions[0]?.shell).toBe(legacyShellTool);
    expect(result.toolsUsed).toEqual(['shell']);
  });

  it('does not queue local shell execution for hosted container shell', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({
      environment: { type: 'container_auto' },
    });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.shellActions).toHaveLength(0);
    expect(result.toolsUsed).toEqual(['shell']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('keeps hosted shell calls pending while still in progress', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'in_progress',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({
      environment: { type: 'container_auto' },
    });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.shellActions).toHaveLength(0);
    expect(result.toolsUsed).toEqual(['shell']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('keeps hosted shell calls pending when status is omitted', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({
      environment: { type: 'container_auto' },
    });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.shellActions).toHaveLength(0);
    expect(result.toolsUsed).toEqual(['shell']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('does not keep hosted shell calls pending when incomplete', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'incomplete',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({
      environment: { type: 'container_auto' },
    });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.shellActions).toHaveLength(0);
    expect(result.toolsUsed).toEqual(['shell']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('does not keep hosted shell calls pending on unknown status values', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'queued' as any,
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const shell = shellTool({
      environment: { type: 'container_auto' },
    });
    const result = processModelResponse(modelResponse, TEST_AGENT, [shell], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.shellActions).toHaveLength(0);
    expect(result.toolsUsed).toEqual(['shell']);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('preserves hosted shell output items in processed run items', () => {
    const shellOutput: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: 'call_shell',
      output: [
        {
          stdout: 'ok',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    };
    const modelResponse: ModelResponse = {
      output: [shellOutput],
      usage: new Usage(),
    };

    const result = processModelResponse(modelResponse, TEST_AGENT, [], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(result.newItems[0].rawItem).toEqual(shellOutput);
    expect(result.toolsUsed).toEqual([]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('keeps hosted shell pending when shell_call_output status is in progress', () => {
    const shellOutput: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: 'call_shell',
      output: [
        {
          stdout: 'partial',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
      providerData: {
        status: 'in_progress',
      },
    };
    const modelResponse: ModelResponse = {
      output: [shellOutput],
      usage: new Usage(),
    };

    const result = processModelResponse(modelResponse, TEST_AGENT, [], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(result.newItems[0].rawItem).toEqual(shellOutput);
    expect(result.toolsUsed).toEqual([]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('does not keep hosted shell pending on unknown shell_call_output status values', () => {
    const shellOutput: protocol.ShellCallResultItem = {
      type: 'shell_call_output',
      callId: 'call_shell',
      output: [
        {
          stdout: 'partial',
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
      providerData: {
        status: 'queued',
      },
    };
    const modelResponse: ModelResponse = {
      output: [shellOutput],
      usage: new Usage(),
    };

    const result = processModelResponse(modelResponse, TEST_AGENT, [], []);

    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(result.newItems[0].rawItem).toEqual(shellOutput);
    expect(result.toolsUsed).toEqual([]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });

  it('throws when shell action emitted without shell tool', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when local shell tool has no shell implementation', () => {
    const shellCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const modelResponse: ModelResponse = {
      output: [shellCall],
      usage: new Usage(),
    };

    const invalidLocalShellTool = {
      type: 'shell',
      name: 'shell',
      environment: { type: 'local' },
      needsApproval: async () => false,
    } as any;

    expect(() =>
      processModelResponse(
        modelResponse,
        TEST_AGENT,
        [invalidLocalShellTool],
        [],
      ),
    ).toThrow(/without a local shell implementation/);
  });

  it('queues apply_patch actions when editor tool registered', () => {
    const applyPatchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'update_file',
        path: 'README.md',
        diff: 'diff --git',
      },
    };
    const modelResponse: ModelResponse = {
      output: [applyPatchCall],
      usage: new Usage(),
    };

    const editor = applyPatchTool({ editor: new FakeEditor() });
    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [editor],
      [],
    );

    expect(result.applyPatchActions).toHaveLength(1);
    expect(result.applyPatchActions[0]?.toolCall).toEqual(applyPatchCall);
    expect(result.applyPatchActions[0]?.applyPatch).toBe(editor);
    expect(result.toolsUsed).toEqual(['apply_patch']);
  });

  it('throws when apply_patch action emitted without editor tool', () => {
    const applyPatchCall: protocol.ApplyPatchCallItem = {
      type: 'apply_patch_call',
      callId: 'call_patch',
      status: 'completed',
      operation: {
        type: 'delete_file',
        path: 'temp.txt',
      },
    };
    const modelResponse: ModelResponse = {
      output: [applyPatchCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(modelResponse, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when hosted MCP approval references missing server', () => {
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_request',
      id: 'mcpr_123',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'missing',
        name: 'mcp_approval_request',
        id: 'mcpr_123',
        arguments: {},
      },
    };
    const response: ModelResponse = {
      output: [hostedCall],
      usage: new Usage(),
    };

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('resolves hosted MCP approval requests from tool_search-loaded servers', () => {
    const toolSearchOutput: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      id: 'ts_output_shopify',
      status: 'completed',
      tools: [
        {
          type: 'mcp',
          server_label: 'shopify',
          server_url: 'https://mcp.example.com/shopify',
          require_approval: 'always',
        },
      ],
    } as any;
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_request',
      id: 'mcpr_shopify',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'shopify',
        name: 'mcp_approval_request',
        id: 'mcpr_shopify',
        arguments: {},
      },
    };
    const response: ModelResponse = {
      output: [toolSearchOutput, hostedCall],
      usage: new Usage(),
    };

    const result = processModelResponse(response, TEST_AGENT, [], []);

    expect(result.mcpApprovalRequests).toHaveLength(1);
    expect(result.mcpApprovalRequests[0].mcpTool.providerData).toMatchObject({
      type: 'mcp',
      server_label: 'shopify',
      server_url: 'https://mcp.example.com/shopify',
      require_approval: 'always',
    });
  });

  it('rejects invalid hosted MCP approval policies from tool_search output', () => {
    const toolSearchOutput: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      id: 'ts_output_shopify',
      status: 'completed',
      tools: [
        {
          type: 'mcp',
          server_label: 'shopify',
          server_url: 'https://mcp.example.com/shopify',
          require_approval: {
            always: { tool_names: ['delete'] },
            never: { tool_names: ['delete'] },
          },
        },
      ],
    } as any;
    const response: ModelResponse = {
      output: [toolSearchOutput],
      usage: new Usage(),
    };

    expect(() => processModelResponse(response, TEST_AGENT, [], [])).toThrow(
      UserError,
    );
  });

  it('accepts read-only hosted MCP approval filters from tool_search output', () => {
    const toolSearchOutput: protocol.ToolSearchOutputItem = {
      type: 'tool_search_output',
      id: 'ts_output_shopify',
      status: 'completed',
      tools: [
        {
          type: 'mcp',
          server_label: 'shopify',
          server_url: 'https://mcp.example.com/shopify',
          require_approval: {
            always: { read_only: false },
            never: { tool_names: ['search'], read_only: true },
          },
        },
      ],
    } as any;
    const hostedCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      name: 'mcp_approval_request',
      id: 'mcpr_shopify',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'shopify',
        name: 'mcp_approval_request',
        id: 'mcpr_shopify',
        arguments: {},
      },
    };
    const response: ModelResponse = {
      output: [toolSearchOutput, hostedCall],
      usage: new Usage(),
    };

    const result = processModelResponse(response, TEST_AGENT, [], []);

    expect(result.mcpApprovalRequests[0].mcpTool.providerData).toMatchObject({
      type: 'mcp',
      server_label: 'shopify',
      server_url: 'https://mcp.example.com/shopify',
      require_approval: {
        always: { read_only: false },
        never: { tool_names: ['search'], read_only: true },
      },
    });
  });

  it('captures reasoning items', () => {
    const reasoning: protocol.ReasoningItem = {
      id: 'r1',
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    };
    const response: ModelResponse = { output: [reasoning], usage: new Usage() };
    const result = processModelResponse(response, TEST_AGENT, [TEST_TOOL], []);

    expect(result.newItems[0]).toBeInstanceOf(ReasoningItem);
    expect(result.toolsUsed).toEqual([]);
  });
});

describe('processModelResponse edge cases', () => {
  it('throws when model references unknown tool', () => {
    const badCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: 'missing_tool',
    };
    const response: ModelResponse = {
      output: [badCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when computer action emitted without computer tool', () => {
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'click', x: 1, y: 1, button: 'left' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('classifies functions, handoffs and computer actions', () => {
    const target = new Agent({ name: 'B' });
    const h = handoff(target);
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });

    const funcCall = { ...TEST_MODEL_FUNCTION_CALL, callId: 'f1' };
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const handCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: h.toolName,
      callId: 'h1',
    };
    const response: ModelResponse = {
      output: [funcCall, compCall, handCall, TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(
      response,
      TEST_AGENT,
      [TEST_TOOL, computer],
      [h],
    );

    expect(result.functions[0]?.toolCall).toBe(funcCall);
    expect(result.computerActions[0]?.toolCall).toBe(compCall);
    expect(result.handoffs[0]?.toolCall).toBe(handCall);
    expect(result.toolsUsed).toEqual(['test', computer.name, h.toolName]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
    expect(result.newItems[3]).toBeInstanceOf(MessageOutputItem);
  });

  it('only serializes the first handoff when multiple handoffs are requested', () => {
    const targetB = new Agent({ name: 'B' });
    const targetC = new Agent({ name: 'C' });
    const handoffToB = handoff(targetB);
    const handoffToC = handoff(targetC);
    const handoffCallB: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'h1',
      name: handoffToB.toolName,
      callId: 'hb1',
    };
    const handoffCallC: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'h2',
      name: handoffToC.toolName,
      callId: 'hc1',
    };
    const response: ModelResponse = {
      output: [handoffCallB, handoffCallC],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(
      response,
      TEST_AGENT,
      [],
      [handoffToB, handoffToC],
    );

    expect(result.handoffs).toEqual([
      { toolCall: handoffCallB, handoff: handoffToB },
      { toolCall: handoffCallC, handoff: handoffToC },
    ]);
    expect(result.newItems).toHaveLength(1);
    expect(result.newItems[0]).toBeInstanceOf(HandoffCallItem);
    expect((result.newItems[0] as HandoffCallItem).rawItem.callId).toBe(
      handoffCallB.callId,
    );
  });
});

describe('hasToolsOrApprovalsToRun method', () => {
  it('returns true when handoffs are pending', () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    const response: ModelResponse = {
      output: [{ ...TEST_MODEL_FUNCTION_CALL, name: h.toolName }],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], [h]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when function calls are pending', () => {
    const result = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when computer actions are pending', () => {
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [computer], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns false when no tools or approvals are pending', () => {
    const response: ModelResponse = {
      output: [TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });
});
