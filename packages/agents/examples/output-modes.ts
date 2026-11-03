import { Agent, NativeProvider, OutputValidationError } from '@openai/agents';
import { z } from 'zod';

/** Call from an async application with configured model credentials. */
export async function runOutputModes(): Promise<void> {
  await using provider = new NativeProvider();
  const nativeGreeting = new Agent({
    provider,
    instructions: 'Return a short greeting for the requested person.',
    outputType: {
      mode: 'native',
      schema: z.strictObject({ greeting: z.string() }),
    },
  });

  const promptedGreetings = new Agent({
    provider,
    instructions:
      'Return a short greeting for each requested person, keyed by name.',
    outputType: {
      mode: 'prompted',
      schema: z.record(z.string(), z.string()),
    },
  });

  try {
    const native = await nativeGreeting.run('Greet Ada.');
    console.log(native.finalOutput.greeting);

    const prompted = await promptedGreetings.run('Greet Ada and Grace.');
    console.log(prompted.finalOutput);
  } catch (error) {
    if (!(error instanceof OutputValidationError)) throw error;
    // rawOutput can contain sensitive text; print only the fixed message.
    console.error(error.message);
  }
}
