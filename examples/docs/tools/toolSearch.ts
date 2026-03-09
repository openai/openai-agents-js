import { Agent, tool, toolNamespace, toolSearchTool } from '@openai/agents';
import { z } from 'zod';

const customerIdParams = z.object({
  customerId: z.string().describe('The customer identifier to look up.'),
});

// Keep a standalone deferred tool at the top level when it represents a
// single searchable capability that does not need a shared namespace.
const shippingLookup = tool({
  name: 'get_shipping_eta',
  description: 'Look up a shipment ETA by customer identifier.',
  parameters: customerIdParams,
  deferLoading: true,
  async execute({ customerId }) {
    return {
      customerId,
      eta: '2026-03-07',
      carrier: 'Priority Express',
    };
  },
});

// Group related tools into a namespace when one domain description should
// cover several deferred tools and let tool search load them together.
const crmTools = toolNamespace({
  name: 'crm',
  description: 'CRM tools for customer profile lookups.',
  tools: [
    tool({
      name: 'get_customer_profile',
      description: 'Fetch a basic customer profile.',
      parameters: customerIdParams,
      deferLoading: true,
      async execute({ customerId }) {
        return {
          customerId,
          tier: 'enterprise',
        };
      },
    }),
  ],
});

const agent = new Agent({
  name: 'Operations assistant',
  model: 'gpt-5.4',
  // Mixing namespaced and top-level deferred tools in one request is supported.
  tools: [shippingLookup, ...crmTools, toolSearchTool()],
});
