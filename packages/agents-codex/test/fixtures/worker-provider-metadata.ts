import {
  AiSdkModel,
  runWorkerText,
  standaloneTool,
} from '../../src/runtime/workerd';
import { z } from 'zod';

export async function providerMetadataFixture(
  control: WebAssembly.Module,
  mode: 'buffered' | 'streamed',
  foreign = false,
) {
  const canary = 'private-worker-continuation';
  const prompts: any[][] = [];
  let effects = 0;
  let stored: string | null = null;
  const observed: unknown[] = [];
  const metadata = (suffix: string) => ({
    fixture: { continuation: canary + '-' + suffix },
  });
  const first = {
    content: [
      {
        type: 'reasoning',
        text: 'Reason.',
        providerMetadata: metadata('reasoning'),
      },
      {
        type: 'tool-call',
        toolCallId: 'call-worker-metadata',
        toolName: 'lookup',
        input: '{}',
        providerMetadata: metadata('tool'),
      },
    ],
    finishReason: 'tool-calls',
  };
  const done = () => ({
    content: [
      { type: 'text', text: 'Done.', providerMetadata: metadata('final') },
    ],
    finishReason: 'stop',
  });
  const adapter = (provider = 'fixture.metadata') => {
    const produce = (options: any) => {
      prompts.push(options.prompt);
      return prompts.length === 1 ? first : done();
    };
    return new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider,
        modelId: 'worker-metadata',
        doGenerate: produce,
        doStream(options) {
          const result = produce(options);
          return {
            stream: new ReadableStream({
              start(c) {
                for (const part of result.content) {
                  if (part.type === 'reasoning') {
                    c.enqueue({ type: 'reasoning-start', id: 'reason' });
                    c.enqueue({
                      type: 'reasoning-delta',
                      id: 'reason',
                      delta: part.text,
                      providerMetadata: part.providerMetadata,
                    });
                    c.enqueue({ type: 'reasoning-end', id: 'reason' });
                  } else if (part.type === 'text')
                    c.enqueue({
                      type: 'text-delta',
                      id: 'answer',
                      delta: part.text,
                      providerMetadata: part.providerMetadata,
                    });
                  else c.enqueue(part);
                }
                c.enqueue({
                  type: 'finish',
                  finishReason: result.finishReason,
                });
                c.close();
              },
            }),
          };
        },
      },
      {},
      { stream: mode === 'streamed' },
    );
  };
  const store = {
    async acquire() {
      return 'fixture-owner';
    },
    async read() {
      return stored;
    },
    async commit(
      _id: string,
      _fence: string,
      _write: string,
      expected: number,
      value: string,
    ) {
      if ((stored === null ? 0 : JSON.parse(stored).revision) !== expected)
        throw Error('Wrong metadata checkpoint revision');
      stored = value;
    },
    async release() {},
  };
  const options = {
    control,
    provider: adapter(),
    model: 'worker-metadata',
    instructions: 'Use lookup then answer.',
    tools: [
      standaloneTool({
        name: 'lookup',
        parameters: z.object({}),
        execute() {
          effects++;
          return 'accepted';
        },
      }),
    ],
    session: { id: 'metadata-owner', store },
    ...(mode === 'streamed'
      ? {
          observe: (event: unknown) => {
            observed.push(event);
          },
        }
      : {}),
  };
  const text = await runWorkerText('Start.', options);
  const secondPrompt = prompts[1];
  if (
    !JSON.stringify(secondPrompt).includes(canary + '-reasoning') ||
    !JSON.stringify(secondPrompt).includes(canary + '-tool')
  )
    throw Error('Missing native tool-loop continuation metadata');
  if (!stored || !stored.includes(canary + '-final'))
    throw Error('Missing completed checkpoint metadata');
  const resumed = await runWorkerText('Continue.', {
    ...options,
    provider: foreign ? adapter('fixture.foreign') : options.provider,
  });
  const replay = JSON.stringify(prompts[2]);
  if (replay.includes(canary) === foreign)
    throw Error('Wrong restored provider metadata scope');
  if (
    JSON.stringify(observed).includes(canary) ||
    JSON.stringify(observed).includes('__sdk_model_provider_metadata')
  )
    throw Error('Worker observer exposed private metadata');
  if (
    text !== 'Done.' ||
    resumed !== 'Done.' ||
    effects !== 1 ||
    prompts.length !== 3
  )
    throw Error('Unexpected metadata fixture outcome');
  return {
    text,
    resumed,
    effects,
    requests: prompts.length,
    foreign,
    privateCheckpoint: true,
    privateObserver: false,
  };
}
