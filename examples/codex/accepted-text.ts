import assert from 'node:assert/strict';
import { Agent, NativeProvider, type ModelRequest } from '@openai/agents';

async function main() {
  // A scripted NativeModel has been keeping generation open until publication.
  const release = Promise.withResolvers<void>();
  let settled = false;
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        throw new Error('Expected a streaming model request');
      },
      async *stream(): AsyncGenerator<ModelRequest['body']> {
        yield {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            role: 'assistant',
            id: 'inventory',
            content: [],
          },
        };
        yield {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'inventory',
          delta: 'Inventory: 12.\n',
        };
        await release.promise;
        yield {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'inventory',
          delta: 'Unsupported delivery claim.',
        };
        yield {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            role: 'assistant',
            id: 'inventory',
            content: [
              {
                type: 'output_text',
                text: 'Inventory: 12.\nUnsupported delivery claim.',
              },
            ],
          },
        };
        yield {
          type: 'response.completed',
          response: { id: 'fixture-response', status: 'completed' },
        };
        settled = true;
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Report synthetic inventory.',
    model: 'fixture-model',
    provider,
  }).session();
  const turn = await session.submit('Begin');
  const published: string[] = [];
  try {
    for await (const chunk of turn.acceptedText((pending) =>
      pending === 'Inventory: 12.\n' ? pending : undefined,
    )) {
      assert.equal(settled, false);
      published.push(chunk.text);
      release.resolve();
    }
    await turn.wait();
    assert.deepEqual(published, ['Inventory: 12.\n']);
    process.stdout.write(published.join(''));
  } finally {
    release.resolve();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
