import { Agent, programmaticToolCallingTool, tool } from '@openai/agents';
import { z } from 'zod';

const getInventory = tool({
  name: 'get_inventory',
  description: 'Return inventory for a SKU.',
  parameters: z.object({ sku: z.string() }),
  allowedCallers: ['programmatic'],
  outputSchema: z.object({
    sku: z.string(),
    availableUnits: z.number(),
  }),
  async execute({ sku }) {
    return { sku, availableUnits: 42 };
  },
});

const getDemand = tool({
  name: 'get_demand',
  description: 'Return requested units for a SKU.',
  parameters: z.object({ sku: z.string() }),
  allowedCallers: ['programmatic'],
  outputSchema: z.object({
    sku: z.string(),
    requestedUnits: z.number(),
  }),
  async execute({ sku }) {
    return { sku, requestedUnits: 31 };
  },
});

const agent = new Agent({
  name: 'Inventory planner',
  model: 'gpt-5.6',
  instructions: `
Use Programmatic Tool Calling to fetch inventory and demand concurrently.
Return the source values and the calculated shortage in the final answer.
  `.trim(),
  tools: [getInventory, getDemand, programmaticToolCallingTool()],
});
