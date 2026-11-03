import {
  Agent,
  NativeProvider,
  OutputValidationError,
  type NativeProviderOptions,
  type UserMessage,
} from '@openai/agents';
import { z } from 'zod';

export const answerSchema = z.strictObject({
  dominantColor: z.enum(['red', 'green', 'blue', 'unknown']),
});
export type ImageAnswer = z.infer<typeof answerSchema>;

/** A valid 1-by-1 red RGB PNG, owned by this application. */
export function imageMessage(): UserMessage {
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: 'What is the dominant color in this image?' },
      {
        type: 'input_image',
        image_url:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
        detail: 'auto',
      },
    ],
  };
}

/** Make a live image request and return its locally validated final answer. */
export async function runImageInput(
  options: NativeProviderOptions = {},
): Promise<ImageAnswer> {
  await using provider = new NativeProvider(options);
  const agent = new Agent<undefined, ImageAnswer>({
    provider,
    instructions:
      'Identify the dominant color. Return unknown if you cannot determine it.',
    outputType: answerSchema,
  });
  return (await agent.run(imageMessage())).finalOutput;
}

if (typeof require !== 'undefined' && require.main === module) {
  runImageInput({ baseUrl: process.env.OPENAI_BASE_URL }).then(
    (answer) => console.log(answer),
    (error: unknown) => {
      console.error(
        error instanceof OutputValidationError ? error.message : error,
      );
      process.exitCode = 1;
    },
  );
}
