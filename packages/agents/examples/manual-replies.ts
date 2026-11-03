import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  type NativeProviderOptions,
} from '@openai/agents';
import { z } from 'zod';

export const lookup = manualTool({
  name: 'lookup',
  description: 'Ask the application for a record label.',
  parameters: z.strictObject({ key: z.string() }),
  result: z.strictObject({ label: z.string().min(1) }),
});

const instructions = 'Use lookup to find the label for the requested record.';

function createAgent(provider: NativeProvider) {
  return new Agent({ instructions, tools: [lookup], provider });
}

/** Stop at the supported manual boundary and return checkpoint JSON. */
export async function savePendingLookup(
  options: NativeProviderOptions = {},
): Promise<string> {
  await using provider = new NativeProvider(options);
  await using session = await createAgent(provider).session();
  // Capture a static operation selection, not a preparation callback.
  const turn = await session.submit('Find the label for record-a.', {
    tools: [lookup],
  });
  const outcome = await turn.wait({ until: 'request' });
  if (!('requests' in outcome))
    throw new Error('The run completed without requesting lookup.');
  for (const action of outcome.requests)
    if (!lookup.match(action))
      throw new Error('The run requested an unexpected manual tool.');
  return JSON.stringify(await session.suspend());
}

/** Restore a trusted checkpoint and answer its fresh request. */
export async function resumeLookup(
  json: string,
  label: string,
  options: NativeProviderOptions = {},
): Promise<string> {
  // Validate the full envelope first; a version number alone grants no authority.
  const state = parseSessionState(json);
  if (
    state.format_version !== 3 &&
    state.format_version !== 5 &&
    state.format_version !== 7 &&
    state.format_version !== 9 &&
    state.format_version !== 11 &&
    state.format_version !== 13 &&
    state.format_version !== 15
  )
    throw new TypeError('Expected a pending manual checkpoint.');
  await using provider = new NativeProvider(options);
  const result = await createAgent(provider).run(null, {
    state,
    onInteraction(action) {
      const request = lookup.match(action);
      if (!request) throw new Error('Unexpected manual tool.');
      return request.reply({ label });
    },
  });
  return result.finalOutput;
}

/** Answer immediately when the application can keep the run open. */
export async function runLookupWithHandler(
  options: NativeProviderOptions = {},
): Promise<string> {
  await using provider = new NativeProvider(options);
  const result = await createAgent(provider).run(
    'Find the label for record-a.',
    {
      onInteraction(action) {
        const request = lookup.match(action);
        if (!request) throw new Error('Unexpected manual tool.');
        return request.reply({ label: `Label for ${request.arguments.key}` });
      },
    },
  );
  return result.finalOutput;
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Set OPENAI_API_KEY for the manual-reply example.');
  const options = { baseUrl: process.env.OPENAI_BASE_URL };
  const saved = await savePendingLookup(options);
  console.log(await resumeLookup(saved, 'Label for record-a', options));
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
