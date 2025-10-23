import { Agent, run, fileSearchTool, withTrace } from '@openai/agents';
import OpenAI, { toFile } from 'openai';

async function main() {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const text = `Arrakis, the desert planet in Frank Herbert's "Dune," was inspired by the scarcity of water
    as a metaphor for oil and other finite resources.`;
  const upload = await client.files.create({
    file: await toFile(Buffer.from(text, 'utf-8'), 'cafe.txt'),
    purpose: 'assistants',
  });
  const vectorStore = await client.vectorStores.create({
    name: 'Arrakis',
  });
  console.log(vectorStore);
  const indexed = await client.vectorStores.files.createAndPoll(
    vectorStore.id,
    { file_id: upload.id },
  );
  console.log(indexed);

  const agent = new Agent({
    name: 'File searcher',
    instructions: 'You are a helpful agent.',
    tools: [
      fileSearchTool([vectorStore.id], {
        maxNumResults: 3,
        includeSearchResults: true,
      }),
    ],
  });

  await withTrace('File search example', async () => {
    const result = await run(
      agent,
      'Be concise, and tell me 1 sentence about Arrakis I might not know.',
    );
    console.log(result.finalOutput);
    /*
    Arrakis, the desert planet in Frank Herbert's "Dune," was inspired by the scarcity of water
    as a metaphor for oil and other finite resources.
    */

    console.log(
      '\n' +
        result.newItems.map((out: unknown) => JSON.stringify(out)).join('\n'),
    );
    /*
    {"id":"...", "queries":["Arrakis"], "results":[...]}
    */
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
