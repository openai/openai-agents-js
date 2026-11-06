import { Agent, NativeProvider, webSearch } from '@openai/agents';

async function main() {
  await using provider = new NativeProvider();
  const researcher = new Agent({
    instructions:
      'Research the question using the admitted search tool. Attribute facts to the sources actually returned.',
    model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
    provider,
    modelSettings: { toolChoice: 'required' },
    tools: [
      webSearch({
        route: 'hosted',
        allowedDomains: ['nodejs.org'],
        location: { country: 'US', timezone: 'America/Chicago' },
      }),
    ],
  });
  await using session = await researcher.session();
  const turn = await session.submit(
    process.argv[2] ??
      'Find the official Node.js documentation for async disposal.',
  );
  console.log((await turn.wait()).finalOutput);
  for await (const item of session.items()) {
    if (item.type === 'web_search_call' && item.action?.type === 'search') {
      for (const source of item.action.sources ?? []) console.log(source.url);
    } else if (item.type === 'message' && item.role === 'assistant') {
      for (const part of item.content) {
        if (part.type !== 'output_text' || !Array.isArray(part.annotations))
          continue;
        for (const annotation of part.annotations) {
          if (
            annotation &&
            typeof annotation === 'object' &&
            !Array.isArray(annotation) &&
            annotation.type === 'url_citation' &&
            typeof annotation.url === 'string' &&
            typeof annotation.title === 'string'
          )
            console.log(annotation.title, annotation.url);
        }
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
