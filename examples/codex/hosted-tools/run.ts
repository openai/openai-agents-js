import {
  Agent,
  NativeProvider,
  codeInterpreter,
  fileSearch,
  imageGeneration,
} from '@openai/agents';

async function main() {
  await using provider = new NativeProvider();
  const vectorStoreId = process.env.VECTOR_STORE_ID;
  const agent = new Agent({
    provider,
    model: process.env.OPENAI_MODEL ?? 'gpt-5.2',
    instructions:
      'Use the available hosted tools to answer the request. Preserve artifact references in your answer.',
    tools: [
      codeInterpreter({ container: { type: 'auto' } }),
      imageGeneration({ partialImages: 1 }),
      ...(vectorStoreId
        ? [fileSearch(vectorStoreId, { includeSearchResults: true })]
        : []),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit(
    process.argv[2] ??
      'Use Python to calculate the first ten squares, then generate a simple image of the result.',
  );
  console.log((await turn.wait()).finalOutput);
  for await (const item of session.items()) {
    if (
      item.type === 'file_search_call' ||
      item.type === 'code_interpreter_call' ||
      item.type === 'image_generation_call'
    )
      console.log(JSON.stringify(item));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
