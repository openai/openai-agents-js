import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, type SessionState } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it.each([false, true])(
  'keeps only current SDK instructions in live and restored prepared input (distinct=%s)',
  async (distinct) => {
    const sourceMarker = 'SDK_SOURCE_ALPHA_SECRET';
    const targetMarker = 'SDK_DESTINATION_BETA_ONLY';
    const updatedMarker = 'SDK_DESTINATION_UPDATED_ONLY';
    const completions = [
      [message('done')],
      [message('updated')],
      [message('restored')],
    ];
    const sourceServer = new ModelServer([
      [call('transfer_to_b', {}, { callId: 'redacted-transfer' })],
      ...(distinct ? [] : completions),
    ]);
    const targetServer = distinct ? new ModelServer(completions) : sourceServer;
    const makeProvider = async (server: ModelServer, key: string) => {
      const config = await server.config();
      return new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: key,
        supportsWebsockets: false,
      });
    };
    await using sourceProvider = await makeProvider(
      sourceServer,
      'synthetic-source',
    );
    const destinationProvider = distinct
      ? await makeProvider(targetServer, 'synthetic-destination')
      : sourceProvider;
    try {
      const target = new Agent({
        name: 'B',
        instructions: targetMarker,
        provider: destinationProvider,
        model: 'gpt-5.5',
      });
      const source = new Agent({
        instructions: sourceMarker,
        provider: sourceProvider,
        model: 'gpt-5.5',
        handoffs: [target],
        prepareHandoffInput: (value) => ({
          ...value,
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'Retained handoff summary.' },
              ],
            },
          ],
          previous: [],
          generated: [],
        }),
      });
      const offset = distinct ? 0 : 1;
      const check = (index: number, marker: string) => {
        const wire = JSON.stringify(targetServer.requests[offset + index]);
        expect(wire).toContain(marker);
        expect(wire).toContain('Retained handoff summary.');
        expect(wire).not.toContain('USER_SOURCE_PRIVATE');
        expect(wire).not.toContain(sourceMarker);
        if (marker === updatedMarker) expect(wire).not.toContain(targetMarker);
      };
      let state: SessionState;
      {
        await using session = await source.session();
        expect(
          (await (await session.submit('USER_SOURCE_PRIVATE')).wait())
            .finalOutput,
        ).toBe('done');
        if (process.env.HANDOFF_REDACTION_RECEIPT) {
          await writeFile(
            process.env.HANDOFF_REDACTION_RECEIPT + '.' + distinct + '.json',
            JSON.stringify(targetServer.requests[offset], null, 2),
          );
        }
        expect(JSON.stringify(sourceServer.requests[0])).toContain(
          sourceMarker,
        );
        check(0, targetMarker);
        const original = await session.saveState();
        expect(JSON.stringify(original.history)).toContain(sourceMarker);
        expect(
          JSON.stringify((await session.historySnapshot()).items),
        ).toContain('USER_SOURCE_PRIVATE');
        await session.update({ instructions: updatedMarker });
        expect(
          (await (await session.submit('live follow-up')).wait()).finalOutput,
        ).toBe('updated');
        check(1, updatedMarker);
        state = await session.saveState();
      }
      await using restored = await source.session({ state });
      expect(
        (await (await restored.submit('cold follow-up')).wait()).finalOutput,
      ).toBe('restored');
      check(2, updatedMarker);
      expect(JSON.stringify((await restored.saveState()).history)).toContain(
        sourceMarker,
      );
      sourceServer.assertExhausted();
      if (distinct) targetServer.assertExhausted();
    } finally {
      if (distinct) await destinationProvider.close();
    }
  },
  30_000,
);
