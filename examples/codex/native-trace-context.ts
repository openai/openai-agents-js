import {
  Agent,
  NativeProvider,
  TraceContext,
  tool,
  type TraceContextHeaders,
} from '@openai/agents';
import { z } from 'zod';

// The application owns ingress instrumentation and passes only W3C headers.
// Configure native telemetry before calling this function to export native spans.
export async function runWithTrace(headers: TraceContextHeaders) {
  await using provider = new NativeProvider();
  const specialist = new Agent({
    provider,
    instructions: 'Answer the supplied question.',
  });
  const delegate = tool({
    name: 'ask_specialist',
    description: 'Ask a specialist to answer a question.',
    parameters: z.object({ question: z.string() }),
    async execute({ question }, context) {
      // This immutable carrier identifies the issuing native tool span.
      // An HTTP client can also inject context.traceContext?.toHeaders().
      const result = await specialist.run(question, {
        parentTrace: context.traceContext,
      });
      return result.finalOutput;
    },
  });
  const agent = new Agent({
    provider,
    instructions: 'Use ask_specialist to answer the question.',
    tools: [delegate],
  });
  const session = await agent.session({
    parentTrace: new TraceContext(headers),
  });
  try {
    const turn = await session.submit('What is a distributed trace?');
    return (await turn.wait()).finalOutput;
  } finally {
    await session.close();
  }
}
