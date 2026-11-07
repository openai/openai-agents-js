import {
  Agent,
  NativeProvider,
  OutputValidationError,
  manualTool,
} from '@openai/agents';
import { z } from 'zod';
const approve = manualTool({
  name: 'approve',
  description: 'Ask the application to approve the report.',
  parameters: z.object({ report: z.string() }),
  result: z.boolean(),
});
/** Call from an async application with configured model credentials. */
export async function runOutputOverrides(): Promise<void> {
  await using provider = new NativeProvider();
  const agent = new Agent({
    provider,
    instructions:
      'Answer directly. Call approve only when explicitly requested.',
    tools: [approve],
  });
  await using session = await agent.session();
  try {
    const native = await session.submit('Count the letters in Ada.', {
      outputType: z.object({ count: z.number() }),
    });
    console.log((await native.wait()).finalOutput.count);
    const prompted = await session.submit(
      'Return greetings keyed by Ada and Grace.',
      {
        outputType: {
          mode: 'prompted',
          schema: z.record(z.string(), z.string()),
        },
      },
    );
    console.log((await prompted.wait()).finalOutput);
    const manual = await session.submit(
      'Call approve once for a report about these greetings, then return the approval decision.',
      { outputType: z.object({ approved: z.boolean() }) },
    );
    for await (const event of session.events()) {
      if (event.type === 'action_requested') {
        const request = approve.match(event);
        if (!request) continue;
        // The application chooses its decision here. respond delivers no root result.
        await session.respond(request.reply(true));
        break;
      }
      if (event.type === 'turn_finished' && event.turnId === manual.turnId)
        throw new Error('The model did not request approval');
    }
    console.log((await manual.wait()).finalOutput.approved);
    // Omission restores the opening plain-text default and its ordinary wait shortcut.
    await session.submit('Summarize the conversation in one sentence.');
    console.log((await session.wait()).finalOutput);
  } catch (error) {
    if (!(error instanceof OutputValidationError)) throw error;
    console.error(error.message); // rawOutput deliberately stays private.
  }
}
