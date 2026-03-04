import {
  Agent,
  run,
  tool,
  toolNamespace,
  toolSearchTool,
  withTrace,
} from '@openai/agents';
import { z } from 'zod';

const customerIdParams = z.object({
  customerId: z.string().describe('The customer identifier to look up.'),
});

const trackingNumberParams = z.object({
  trackingNumber: z.string().describe('The tracking number to look up.'),
});

const crmTools = toolNamespace({
  name: 'crm',
  description: 'CRM tools for customer profile and support lookups.',
  tools: [
    tool({
      name: 'get_customer_profile',
      description: 'Fetch a basic customer profile.',
      parameters: customerIdParams,
      deferLoading: true,
      execute: async ({ customerId }) => {
        if (customerId !== 'customer_42') {
          return null;
        }

        return {
          customerId,
          fullName: 'Avery Chen',
          tier: 'enterprise',
        };
      },
    }),
    tool({
      name: 'list_recent_support_tickets',
      description: 'List recent support tickets for a customer.',
      parameters: customerIdParams,
      deferLoading: true,
      execute: async ({ customerId }) => {
        if (customerId !== 'customer_42') {
          return [];
        }

        return [
          {
            ticketId: 'ticket_991',
            status: 'open',
            summary: 'Requested shipment ETA after warehouse split.',
          },
        ];
      },
    }),
  ],
});

const billingTools = toolNamespace({
  name: 'billing',
  description: 'Billing tools for invoice lookups.',
  tools: [
    tool({
      name: 'get_invoice_status',
      description: 'Look up invoice status for a customer.',
      parameters: customerIdParams,
      deferLoading: true,
      execute: async ({ customerId }) => {
        if (customerId !== 'customer_42') {
          return null;
        }

        return {
          invoiceId: 'inv_4201',
          status: 'paid',
        };
      },
    }),
  ],
});

const getShippingEta = tool({
  name: 'get_shipping_eta',
  description: 'Look up a shipment ETA by tracking number.',
  parameters: trackingNumberParams,
  deferLoading: true,
  execute: async ({ trackingNumber }) => {
    if (trackingNumber !== 'ZX-123') {
      return null;
    }

    return {
      trackingNumber,
      eta: '2026-03-07',
      carrier: 'Priority Express',
    };
  },
});

const getShippingCreditBalance = tool({
  name: 'get_shipping_credit_balance',
  description: 'Look up a customer shipping credit balance.',
  parameters: customerIdParams,
  deferLoading: true,
  execute: async ({ customerId }) => {
    if (customerId !== 'customer_42') {
      return null;
    }

    return {
      customerId,
      creditBalance: 125,
      currency: 'USD',
    };
  },
});

async function main() {
  const namespacedAgent = new Agent({
    name: 'CRM assistant',
    model: 'gpt-5.4',
    instructions:
      'For customer questions in this example, load the full crm namespace with no query filter before calling tools. Do not search billing unless the user explicitly asks about invoices.',
    modelSettings: {
      parallelToolCalls: false,
    },
    tools: [...crmTools, ...billingTools, toolSearchTool()],
  });
  const topLevelAgent = new Agent({
    name: 'Shipping assistant',
    model: 'gpt-5.4',
    instructions:
      'Use shipping tools to answer shipping questions. For tracking-number ETA questions, search only get_shipping_eta. Do not search get_shipping_credit_balance unless the user asks about credits or balances.',
    modelSettings: {
      parallelToolCalls: false,
    },
    tools: [getShippingEta, getShippingCreditBalance, toolSearchTool()],
  });

  await withTrace('Tool search example', async () => {
    const namespacedResult = await run(
      namespacedAgent,
      'Look up customer_42 and summarize their profile and recent support activity.',
    );
    const namespacedLoadedTools = getLoadedTools(namespacedResult.newItems);
    const namespacedCalledTools = getCalledTools(namespacedResult.newItems);
    const allNamespacedTools = [
      'crm.get_customer_profile',
      'crm.list_recent_support_tickets',
      'billing.get_invoice_status',
    ];

    console.log('### Tool search with namespaces');
    console.log(namespacedResult.finalOutput);
    console.log(`Loaded tools: ${formatList(namespacedLoadedTools)}`);
    console.log(
      `Not loaded tools: ${formatList(
        allNamespacedTools.filter(
          (toolName) => !namespacedLoadedTools.includes(toolName),
        ),
      )}`,
    );
    console.log(`Called tools: ${formatList(namespacedCalledTools)}`);
    console.log();

    const topLevelResult = await run(
      topLevelAgent,
      'Can you check the shipping ETA for tracking number ZX-123?',
    );
    const topLevelLoadedTools = getLoadedTools(topLevelResult.newItems);
    const topLevelCalledTools = getCalledTools(topLevelResult.newItems);
    const allTopLevelTools = [
      'get_shipping_eta',
      'get_shipping_credit_balance',
    ];

    console.log('### Top-level deferred tools');
    console.log(topLevelResult.finalOutput);
    console.log(`Loaded tools: ${formatList(topLevelLoadedTools)}`);
    console.log(
      `Not loaded tools: ${formatList(
        allTopLevelTools.filter(
          (toolName) => !topLevelLoadedTools.includes(toolName),
        ),
      )}`,
    );
    console.log(`Called tools: ${formatList(topLevelCalledTools)}`);
  });
}

type ExampleRunItem = {
  type: string;
  rawItem?: unknown;
};

function getLoadedTools(newItems: ExampleRunItem[]): string[] {
  return [
    ...new Set(
      newItems.flatMap((item) => {
        if (
          item.type !== 'tool_search_output_item' ||
          typeof item.rawItem !== 'object' ||
          item.rawItem === null
        ) {
          return [];
        }

        const tools = (item.rawItem as { tools?: unknown }).tools;
        if (!Array.isArray(tools)) {
          return [];
        }

        return extractLoadedToolNames(tools);
      }),
    ),
  ];
}

function extractLoadedToolNames(
  tools: unknown[],
  namespacePrefix?: string,
): string[] {
  return tools.flatMap((toolEntry) => {
    if (typeof toolEntry !== 'object' || toolEntry === null) {
      return [];
    }

    const tool = toolEntry as {
      type?: unknown;
      name?: unknown;
      tools?: unknown;
      functionName?: unknown;
      namespace?: unknown;
    };

    if (tool.type === 'namespace') {
      const namespace =
        typeof tool.name === 'string'
          ? namespacePrefix
            ? `${namespacePrefix}.${tool.name}`
            : tool.name
          : namespacePrefix;
      if (!namespace) {
        return [];
      }
      if (!Array.isArray(tool.tools) || tool.tools.length === 0) {
        return [namespace];
      }
      return extractLoadedToolNames(tool.tools, namespace);
    }

    if (
      tool.type === 'tool_reference' &&
      typeof tool.functionName === 'string'
    ) {
      const namespace =
        typeof tool.namespace === 'string' ? tool.namespace : namespacePrefix;
      return [
        namespace ? `${namespace}.${tool.functionName}` : tool.functionName,
      ];
    }

    if (tool.type === 'function' && typeof tool.name === 'string') {
      return [namespacePrefix ? `${namespacePrefix}.${tool.name}` : tool.name];
    }

    return [];
  });
}

function getCalledTools(newItems: ExampleRunItem[]): string[] {
  return [
    ...new Set(
      newItems.flatMap((item) => {
        if (
          item.type !== 'tool_call_item' ||
          typeof item.rawItem !== 'object' ||
          item.rawItem === null
        ) {
          return [];
        }

        const name = (item.rawItem as { name?: unknown }).name;
        if (typeof name !== 'string') {
          return [];
        }

        const namespace = (item.rawItem as { namespace?: unknown }).namespace;
        if (typeof namespace !== 'string' || namespace === name) {
          return [name];
        }

        return [`${namespace}.${name}`];
      }),
    ),
  ];
}

function formatList(values: string[]): string {
  return values.join(', ') || 'none';
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
