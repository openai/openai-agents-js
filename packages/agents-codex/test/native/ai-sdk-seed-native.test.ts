import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
it.each(
  [undefined, 0, 17].flatMap((seed) =>
    [false, true].map((stream) => ({ seed, stream })),
  ),
)(
  'forwards an admitted AI SDK seed without HTTP option bleed: $seed (stream=$stream)',
  async ({ seed, stream }) => {
    const requests: any[] = [];
    const backend = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'fixture.seed',
        modelId: 'fixture',
        doGenerate(options) {
          requests.push(options);
          return {
            content: [{ type: 'text', text: 'Done.' }],
            finishReason: 'stop',
          };
        },
        doStream(options) {
          requests.push(options);
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'text-delta', id: 'answer', delta: 'Done.' });
                c.enqueue({ type: 'finish', finishReason: 'stop' });
                c.close();
              },
            }),
          };
        },
      },
      {},
      { stream },
    );
    await using provider = new NativeProvider({ modelBackend: backend });
    const result = await new Agent({
      model: 'fixture',
      instructions: 'Answer.',
      provider,
      ...(seed === undefined ? {} : { modelSettings: { extraBody: { seed } } }),
    }).run('Start.');
    expect(result.finalOutput).toBe('Done.');
    expect(requests).toHaveLength(1);
    expect(requests[0].seed).toBe(seed);
    expect(requests[0].providerOptions).not.toHaveProperty('seed');
    expect(requests[0]).not.toHaveProperty('headers.seed');
  },
);
it.each(['wrong', 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects an invalid AI SDK seed before provider invocation: %s',
  async (seed) => {
    let calls = 0;
    const backend = new AiSdkModel({
      specificationVersion: 'v3',
      provider: 'fixture.seed',
      modelId: 'fixture',
      doGenerate() {
        calls++;
        throw Error('Provider invoked');
      },
    });
    await using provider = new NativeProvider({ modelBackend: backend });
    await expect(
      new Agent({
        model: 'fixture',
        instructions: 'Answer.',
        provider,
        modelSettings: { extraBody: { seed } },
      }).run('Start.'),
    ).rejects.toThrow(/seed|safe|JSON/);
    expect(calls).toBe(0);
  },
);
