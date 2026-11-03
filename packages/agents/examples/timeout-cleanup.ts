import {
  Agent,
  NativeProvider,
  type NativeProviderOptions,
} from '@openai/agents';

/** Bound one result wait, then join cleanup of the Session this example owns. */
export async function runWithTimeout(
  options: NativeProviderOptions = {},
  timeoutMs = 30_000,
) {
  await using provider = new NativeProvider(options);
  const agent = new Agent({ instructions: 'Answer briefly.', provider });
  await using session = await agent.session();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn = await session.submit('What makes a rainbow?');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Result wait exceeded ${timeoutMs} ms.`)),
        timeoutMs,
      );
    });
    // Racing the reader does not stop the Turn. Session disposal owns that step.
    const result = await Promise.race([turn.wait(), deadline]);
    return result.finalOutput;
  } finally {
    clearTimeout(timer);
  }
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  runWithTimeout({ baseUrl: process.env.OPENAI_BASE_URL }).then(
    (answer) => console.log('Answer:', answer),
    (error: unknown) => {
      // Log the whole failure, including any SuppressedError cleanup chain.
      console.error(error);
      process.exitCode = 1;
    },
  );
}
