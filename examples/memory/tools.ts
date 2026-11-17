import { tool, type RunItem } from '@openai/agents';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const SAMPLE_IMAGE_URL = new URL(
  '../basic/media/image_bison.jpg',
  import.meta.url,
);
const SAMPLE_IMAGE_BASE64 = readFileSync(SAMPLE_IMAGE_URL).toString('base64');
const SAMPLE_IMAGE_MEDIA_TYPE = 'image/jpeg';

const LookupCustomerProfileParameters = z.object({
  id: z
    .string()
    .describe('The internal identifier for the customer to retrieve.'),
});

type LookupCustomerProfileOptions = {
  directory: Record<string, string>;
  name?: string;
  description?: string;
  transientErrorMessage?: string;
  missingCustomerMessage?: (id: string) => string;
};

export function createLookupCustomerProfileTool(
  options: LookupCustomerProfileOptions,
) {
  const {
    directory,
    name = 'lookup_customer_profile',
    description = 'Look up stored profile details for a customer by their internal id.',
    transientErrorMessage = 'Simulated transient CRM outage. Please retry the tool call.',
    missingCustomerMessage = (id: string) => `No customer found for id ${id}.`,
  } = options;

  let hasSimulatedLookupFailure = false;

  return tool({
    name,
    description,
    parameters: LookupCustomerProfileParameters,
    async execute({ id }: z.infer<typeof LookupCustomerProfileParameters>) {
      if (!hasSimulatedLookupFailure) {
        hasSimulatedLookupFailure = true;
        throw new Error(transientErrorMessage);
      }
      return directory[id] ?? missingCustomerMessage(id);
    },
  });
}

const FetchImageDataParameters = z.object({
  label: z
    .string()
    .max(32)
    .optional()
    .nullable()
    .describe('An optional short label to echo back in the response.'),
});

/**
 * Fetches a reusable image so downstream samples can verify binary persistence.
 */
export const fetchImageData = tool({
  name: 'fetch_image_data',
  description:
    'Returns a JPEG sample image as raw bytes so you can confirm image persistence.',
  parameters: FetchImageDataParameters,
  async execute({ label }: z.infer<typeof FetchImageDataParameters>) {
    const filename = label
      ? `sample-image-${sanitizeFilenameFragment(label)}.jpg`
      : 'sample-image.jpg';
    const imageDataUrl = `data:${SAMPLE_IMAGE_MEDIA_TYPE};base64,${SAMPLE_IMAGE_BASE64}`;

    return [
      {
        type: 'text' as const,
        text: label
          ? `Fetched the sample image for "${label}".`
          : 'Fetched the default sample image.',
      },
      {
        type: 'image' as const,
        image: imageDataUrl,
        providerData: { filename },
      },
    ];
  },
});

function sanitizeFilenameFragment(value: string): string {
  return (
    value
      .replace(/[^a-z0-9-_]+/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase()
      .slice(0, 32) || 'label'
  );
}

export function assertMemoryToolCalls(
  result: { newItems: RunItem[] },
  names: readonly string[] = ['lookup_customer_profile', 'fetch_image_data'],
): void {
  for (const name of names) {
    const call = result.newItems.find(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'function_call' &&
        item.rawItem.name === name,
    );
    if (!call || call.rawItem.type !== 'function_call')
      throw new Error(`Expected a ${name} call.`);
    const callId = call.rawItem.callId;
    if (
      !result.newItems.some(
        (item) =>
          item.type === 'tool_call_output_item' &&
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === callId,
      )
    )
      throw new Error(`Expected ${name} to return a tool result.`);
  }
}
