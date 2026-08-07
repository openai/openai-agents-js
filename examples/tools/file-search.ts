import { Agent, run, fileSearchTool, withTrace } from '@openai/agents';
import OpenAI, { toFile } from 'openai';

async function main() {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const text = `Arrakis, the desert planet in Frank Herbert's "Dune," was inspired by the scarcity of water
    as a metaphor for oil and other finite resources.`;
  let uploadId: string | undefined;
  let vectorStoreId: string | undefined;

  try {
    const upload = await client.files.create({
      file: await toFile(Buffer.from(text, 'utf-8'), 'arrakis.txt'),
      purpose: 'assistants',
    });
    uploadId = upload.id;

    const vectorStore = await client.vectorStores.create({
      name: 'Arrakis',
      expires_after: { anchor: 'last_active_at', days: 1 },
    });
    vectorStoreId = vectorStore.id;
    console.log(vectorStore);

    const indexed = await client.vectorStores.files.createAndPoll(
      vectorStore.id,
      { file_id: upload.id },
    );
    console.log(indexed);

    const agent = new Agent({
      name: 'File searcher',
      instructions:
        'Always search the uploaded files before answering. Answer only from the file search results.',
      modelSettings: {
        toolChoice: 'required',
      },
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
        'According to the uploaded file, what inspired Arrakis? Answer in one concise sentence.',
      );
      console.log(result.finalOutput);

      const fileSearchCall = result.newItems.find(
        (item) =>
          item.type === 'tool_call_item' &&
          item.rawItem.type === 'hosted_tool_call' &&
          item.rawItem.name === 'file_search_call',
      );
      if (!fileSearchCall) {
        throw new Error('Expected the agent to call the file search tool.');
      }

      console.log(JSON.stringify(fileSearchCall, null, 2));
    });
  } finally {
    try {
      if (vectorStoreId) {
        await client.vectorStores.delete(vectorStoreId);
        console.log(`Deleted vector store ${vectorStoreId}.`);
      }
    } finally {
      if (uploadId) {
        await client.files.delete(uploadId);
        console.log(`Deleted file ${uploadId}.`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
