import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
it.each(['privacy', 'replay'])(
  'canonicalizes a snake-case Google signature privately on native %s',
  async (check) => {
    const signature = 'synthetic-private-streamed-text-signature';
    const prompts: any[][] = [];
    const backend = new AiSdkModel(
      {
        specificationVersion: 'v3',
        provider: 'google.generative-ai',
        modelId: 'gemini-fixture-signed-text',
        doGenerate() {
          throw new Error('Expected streaming');
        },
        doStream(options) {
          prompts.push(options.prompt);
          const first = prompts.length === 1;
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'text-delta',
                  id: 'text',
                  delta: first ? 'first answer' : 'continued answer',
                  ...(first
                    ? {
                        providerMetadata: {
                          google: {
                            thought_signature: signature,
                            serviceTier: 'fixture-tier',
                          },
                        },
                      }
                    : {}),
                });
                controller.enqueue({ type: 'finish', finishReason: 'stop' });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream: true },
    );
    await using provider = new NativeProvider({
      modelBackend: backend,
      apiKey: 'synthetic-signed-text',
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gemini-fixture-signed-text',
      provider,
    }).session({ includeRawProviderEvents: true, observationRetention: 'all' });
    const events: any[] = [];
    for (const [input, output] of [
      ['Start.', 'first answer'],
      ['Continue.', 'continued answer'],
    ]) {
      const turn = await session.submit(input);
      const observe = (async () => {
        for await (const event of turn.events({
          includeExecutionDetails: true,
        }))
          events.push(event);
      })();
      expect((await turn.wait()).finalOutput).toBe(output);
      await observe;
    }
    expect(prompts).toHaveLength(2);
    if (check === 'privacy') {
      expect(JSON.stringify(events)).not.toContain(signature);
      return;
    }
    expect(prompts[1].filter((entry) => entry.role === 'assistant')).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'first answer',
            providerOptions: {
              google: {
                thoughtSignature: signature,
                thought_signature: signature,
                serviceTier: 'fixture-tier',
              },
            },
          },
        ],
        providerOptions: {
          google: {
            thoughtSignature: signature,
            thought_signature: signature,
            serviceTier: 'fixture-tier',
          },
        },
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'raw_provider_event',
        payload: expect.objectContaining({
          type: 'text-delta',
          providerMetadata: { google: { serviceTier: 'fixture-tier' } },
        }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain(signature);
    expect(JSON.stringify(await session.historySnapshot())).not.toContain(
      signature,
    );
  },
  30_000,
);
