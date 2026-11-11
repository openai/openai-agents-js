import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, parseSessionState, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt(
  'projects the latest provider compaction across a tool and cold restore while retaining audit history',
  async () => {
    const server = new ModelServer([
      [message('OLD_ASSISTANT_SENTINEL')],
      [
        { type: 'compaction', encrypted_content: 'OPAQUE_FIRST' },
        call('lookup', {}, { callId: 'lookup-once' }),
      ],
      [
        { type: 'compaction', encrypted_content: 'OPAQUE_LATEST' },
        message('LATER_ASSISTANT_SENTINEL'),
      ],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider-compaction',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'CURRENT_APPLICATION_INSTRUCTION_SENTINEL',
      model: 'fixture-provider-compaction',
      provider,
      modelSettings: {
        contextManagement: [{ type: 'compaction', compact_threshold: 1024 }],
      },
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'AFTER_COMPACTION_TOOL_SENTINEL',
        }),
      ],
    });
    const saved = await (async () => {
      await using session = await agent.session();
      await (await session.submit('Before provider compaction.')).wait();
      await (await session.submit('Run lookup now.')).wait();
      return session.saveState();
    })();
    {
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(saved)),
      });
      await (await restored.submit('LATER_USER_SENTINEL')).wait();
    }
    expect(server.requests).toHaveLength(4);
    const followup = server.requests[2]!;
    const later = server.requests[3]!;
    const input = followup.input as { type?: string; call_id?: string }[];
    const followupInput = JSON.stringify(input);
    const laterInput = JSON.stringify(later.input);
    expect(followupInput).not.toContain('OLD_ASSISTANT_SENTINEL');
    expect(followupInput).toContain('OPAQUE_FIRST');
    expect(JSON.stringify(followup)).toContain(
      'CURRENT_APPLICATION_INSTRUCTION_SENTINEL',
    );
    expect(followupInput).toContain('AFTER_COMPACTION_TOOL_SENTINEL');
    expect(
      input
        .filter((item) => item.type === 'function_call')
        .map((item) => item.call_id),
    ).toEqual(['lookup-once']);
    expect(
      input
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.call_id),
    ).toEqual(['lookup-once']);
    expect(laterInput).toContain('OPAQUE_LATEST');
    for (const prior of [
      'OPAQUE_FIRST',
      'OLD_ASSISTANT_SENTINEL',
      'AFTER_COMPACTION_TOOL_SENTINEL',
    ]) {
      expect(laterInput).not.toContain(prior);
    }
    expect(laterInput).toContain('LATER_ASSISTANT_SENTINEL');
    expect(laterInput).toContain('LATER_USER_SENTINEL');
    expect(JSON.stringify(later)).toContain(
      'CURRENT_APPLICATION_INSTRUCTION_SENTINEL',
    );
    expect(JSON.stringify(server.requests)).not.toContain(
      'provider_compaction',
    );
    for (const original of [
      'OLD_ASSISTANT_SENTINEL',
      'OPAQUE_FIRST',
      'OPAQUE_LATEST',
      'AFTER_COMPACTION_TOOL_SENTINEL',
    ]) {
      expect(JSON.stringify(saved)).toContain(original);
    }
  },
  40_000,
);

nativeIt(
  'keeps the provider window through native compaction and cold restore',
  async () => {
    const server = new ModelServer([
      [message('OLD_ASSISTANT_SENTINEL')],
      [
        { type: 'compaction', encrypted_content: 'OPAQUE_PROVIDER_WINDOW' },
        message('Provider summary accepted.'),
      ],
      [message('Current user accepted.')],
      [message('NATIVE_SUMMARY_SENTINEL')],
      [message('done')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-compaction-retention',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      model: 'fixture-provider-compaction',
      instructions: 'Keep the current context.',
      provider,
      modelSettings: {
        contextManagement: [{ type: 'compaction', compact_threshold: 1024 }],
      },
    });
    const saved = await (async () => {
      await using session = await agent.session();
      await (await session.submit('OLD_USER_SENTINEL')).wait();
      await (await session.submit('PROVIDER_TRIGGER_SENTINEL')).wait();
      await (await session.submit('CURRENT_USER_SENTINEL')).wait();
      await session.compact();
      return session.saveState();
    })();
    {
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(saved)),
      });
      expect(
        (
          await (
            await restored.submit('Continue after native compaction.')
          ).wait()
        ).finalOutput,
      ).toBe('done');
    }
    expect(server.requests).toHaveLength(5);
    const compactInput = JSON.stringify(server.requests[3]!.input);
    const finalInput = JSON.stringify(server.requests[4]!.input);
    for (const old of [
      'OLD_USER_SENTINEL',
      'PROVIDER_TRIGGER_SENTINEL',
      'OLD_ASSISTANT_SENTINEL',
    ]) {
      expect(compactInput).not.toContain(old);
      expect(finalInput).not.toContain(old);
      expect(JSON.stringify(saved)).toContain(old);
    }
    expect(finalInput.split('CURRENT_USER_SENTINEL')).toHaveLength(2);
    expect(finalInput).toContain('NATIVE_SUMMARY_SENTINEL');
    server.assertExhausted();
  },
  40_000,
);
