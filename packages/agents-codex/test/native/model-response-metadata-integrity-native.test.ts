import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, NativeProvider, tool } from '../../src';
import { retainModelProviderMetadata } from '../../src/runtime/model-provider-metadata';

it.each([
  { outcome: 'refusal', reason: 'provider_refusal' },
  { outcome: 'malformed', reason: 'undecodable_output_item' },
] as const)(
  'preserves $outcome integrity with sibling provider metadata before tool effects',
  async ({ outcome, reason }) => {
    for (const withMetadata of [false, true]) {
      let effects = 0;
      const response = {
        responseId: 'synthetic-metadata-integrity',
        output: [
          {
            type: 'function_call',
            call_id: 'call_lookup',
            name: 'lookup',
            arguments: '{}',
          },
          {
            type: 'message',
            role: 'assistant',
            content:
              outcome === 'refusal'
                ? [{ type: 'refusal', refusal: 'synthetic-private-refusal' }]
                : [{ type: 'output_text', text: 42 }],
          },
        ],
      };
      if (withMetadata)
        retainModelProviderMetadata(response, 'fixture.metadata', 'fixture', [
          { outputIndex: 0, value: { fixture: { continuation: 'synthetic' } } },
        ]);
      await using provider = new NativeProvider({
        modelBackend: { complete: async () => response },
      });
      await using session = await new Agent({
        model: 'fixture',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute() {
              effects++;
              return 'accepted';
            },
          }),
        ],
      }).session();
      const turn = await session.submit('Run.');
      const failure = await turn.wait().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(NativeError);
      expect((failure as NativeError).responseIntegrityReason).toBe(reason);
      expect(String(failure)).not.toContain('synthetic-private-refusal');
      expect(effects).toBe(0);
    }
  },
);
