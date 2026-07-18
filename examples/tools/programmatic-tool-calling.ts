import { Agent, programmaticToolCallingTool, run, tool } from '@openai/agents';
import { z } from 'zod';

const sku = z.enum(['desk-lamp', 'ergonomic-keyboard', 'usb-c-dock']);
type Sku = z.infer<typeof sku>;

const inventory: Record<Sku, number> = {
  'desk-lamp': 12,
  'ergonomic-keyboard': 7,
  'usb-c-dock': 22,
};

const weeklyDemand: Record<Sku, number> = {
  'desk-lamp': 18,
  'ergonomic-keyboard': 16,
  'usb-c-dock': 14,
};

const inboundUnits: Record<Sku, number> = {
  'desk-lamp': 4,
  'ergonomic-keyboard': 2,
  'usb-c-dock': 0,
};

const skuParameters = z.object({
  sku: sku.describe('The SKU to look up.'),
});

const inventoryOutput = z.object({
  sku,
  availableUnits: z.number(),
});

const weeklyDemandOutput = z.object({
  sku,
  forecastUnits: z.number(),
});

const inboundUnitsOutput = z.object({
  sku,
  inboundUnits: z.number(),
});

const getInventory = tool({
  name: 'get_inventory',
  description: 'Return the currently available units for one SKU.',
  parameters: skuParameters,
  allowedCallers: ['programmatic'],
  outputSchema: inventoryOutput,
  execute: async ({ sku }) => {
    console.log(`[tool] get_inventory(${sku})`);
    return { sku, availableUnits: inventory[sku] };
  },
});

const getWeeklyDemand = tool({
  name: 'get_weekly_demand',
  description: 'Return forecast demand for one SKU for the next seven days.',
  parameters: skuParameters,
  allowedCallers: ['programmatic'],
  outputSchema: weeklyDemandOutput,
  execute: async ({ sku }) => {
    console.log(`[tool] get_weekly_demand(${sku})`);
    return { sku, forecastUnits: weeklyDemand[sku] };
  },
});

const getInboundUnits = tool({
  name: 'get_inbound_units',
  description: 'Return units already scheduled to arrive for one SKU.',
  parameters: skuParameters,
  allowedCallers: ['programmatic'],
  outputSchema: inboundUnitsOutput,
  execute: async ({ sku }) => {
    console.log(`[tool] get_inbound_units(${sku})`);
    return { sku, inboundUnits: inboundUnits[sku] };
  },
});

const agent = new Agent({
  name: 'Replenishment planner',
  model: process.env.PTC_MODEL_NAME ?? 'gpt-5.6',
  instructions: `
<tool_orchestration>
Use Programmatic Tool Calling to prepare a replenishment plan for desk-lamp,
ergonomic-keyboard, and usb-c-dock. For every SKU, call get_inventory,
get_weekly_demand, and get_inbound_units. Create all nine tool-call promises
before awaiting them, then run them concurrently with one Promise.all call.

Use a safety stock of 5 units. Calculate reorderUnits as
max(forecastUnits + 5 - availableUnits - inboundUnits, 0). In the program,
return exactly one JSON object with recommendations and totalReorderUnits.
Each recommendation must include sku, availableUnits, forecastUnits,
inboundUnits, and reorderUnits. Include only positive reorder quantities and
sort recommendations by reorderUnits descending.

Do not call these tools directly. In the final answer, explain the plan using
the source values returned by the program.
</tool_orchestration>
  `.trim(),
  modelSettings: {
    toolChoice: 'programmatic_tool_calling',
  },
  tools: [
    getInventory,
    getWeeklyDemand,
    getInboundUnits,
    programmaticToolCallingTool(),
  ],
});

async function main() {
  const result = await run(
    agent,
    'Which products should we reorder this week, and in what quantities?',
  );

  const programmaticCalls: string[] = [];
  for (const item of result.newItems) {
    if (item.type !== 'tool_call_item') {
      continue;
    }
    if (item.rawItem.type === 'program') {
      console.log(`\nGenerated program:\n${item.rawItem.code}\n`);
    } else if (
      item.rawItem.type === 'function_call' &&
      item.rawItem.caller?.type === 'program'
    ) {
      programmaticCalls.push(item.rawItem.name);
    }
  }

  console.log(`Programmatic calls: ${programmaticCalls.join(', ')}`);
  console.log(`\nFinal answer:\n${result.finalOutput}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
