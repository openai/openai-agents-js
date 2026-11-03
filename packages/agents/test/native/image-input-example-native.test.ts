import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  NativeProvider,
  OutputValidationError,
  type NativeProviderOptions,
} from '@openai/agents';
import { runImageInput, type ImageAnswer } from '../../examples/image-input';
import { ModelServer, message } from './fixtures/model-server';

async function optionsFor(server: ModelServer): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture-image-example',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('image input example through the native runtime', () => {
  it('sends inline image input and schema guidance and returns a typed answer', async () => {
    const server = new ModelServer([[message('{"dominantColor":"red"}')]]);
    const answer = await runImageInput(await optionsFor(server));
    expectTypeOf(answer).toEqualTypeOf<ImageAnswer>();
    expect(answer).toEqual({ dominantColor: 'red' });
    expect(server.requests[0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'What is the dominant color in this image?',
            },
            expect.objectContaining({
              type: 'input_image',
              image_url: expect.stringMatching(/^data:image\/png;base64,/),
            }),
          ],
        }),
      ]),
    );
    expect(server.requests[0].text).toMatchObject({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['dominantColor'],
          properties: {
            dominantColor: {
              type: 'string',
              enum: ['red', 'green', 'blue', 'unknown'],
            },
          },
        },
      },
    });
    server.assertExhausted();
  });

  it('rejects an invalid final answer without requesting a repair', async () => {
    const providerClose = vi.spyOn(NativeProvider.prototype, 'close');
    const server = new ModelServer([
      [message('{"dominantColor":"private-invalid-color"}')],
    ]);
    // The runner settles only after its one-shot Session and owned provider close.
    const failure = await runImageInput(await optionsFor(server)).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OutputValidationError);
    if (!(failure instanceof OutputValidationError))
      throw new Error('Expected a validation error');
    expect(failure.message).toBe(
      'Final output did not match the requested output type',
    );
    expect(String(failure)).not.toContain('private');
    expect(providerClose).toHaveBeenCalledTimes(1);
    // Real provider close rejects if a Session lease remains open.
    await expect(providerClose.mock.results[0].value).resolves.toBeUndefined();
    server.assertExhausted();
  });
});
