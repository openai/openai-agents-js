import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it.each([false, true])(
  'retains completed automatic-second output behind a manual-first approval (restore=%s)',
  async (restore) => {
    const effects: string[] = [];
    let automaticFinished!: () => void;
    const automatic = new Promise<void>((resolve) => {
      automaticFinished = resolve;
    });
    const manual = tool({
      name: 'manual_first',
      parameters: z.object({}),
      needsApproval: true,
      execute: () => {
        effects.push('manual');
        return 'manual accepted';
      },
    });
    const completed = tool({
      name: 'automatic_second',
      parameters: z.object({}),
      execute: () => {
        effects.push('automatic');
        automaticFinished();
        return 'automatic captured';
      },
    });
    const server = new ModelServer([
      [
        call('manual_first', {}, { callId: 'manual-first' }),
        call('automatic_second', {}, { callId: 'automatic-second' }),
      ],
      [message('completed once')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-manual-automatic',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Use both.',
      provider,
      tools: [manual, completed],
    });
    async function approval(session: {
      interactions(): AsyncIterable<unknown>;
    }) {
      for await (const request of session.interactions())
        if (isFunctionApprovalRequest(request)) return request;
      throw new Error('Approval missing');
    }
    let result;
    if (restore) {
      let saved;
      {
        await using source = await agent.session();
        await source.submit('begin');
        await approval(source);
        await automatic;
        saved = await source.suspend();
      }
      expect(effects).toEqual(['automatic']);
      await using session = await agent.session({ state: saved });
      const pending = await approval(session);
      expect(effects).toEqual(['automatic']);
      await session.respond(pending.approve());
      result = await session.restoredTurn!.wait();
    } else {
      await using session = await agent.session();
      const turn = await session.submit('begin');
      const pending = await approval(session);
      await automatic;
      await session.respond(pending.approve());
      result = await turn.wait();
    }
    expect(result.finalOutput).toBe('completed once');
    expect(effects).toEqual(['automatic', 'manual']);
    expect(server.requests).toHaveLength(2);
    const outputs = (
      server.requests[1]!.input as {
        type: string;
        call_id?: string;
        output?: unknown;
      }[]
    ).filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual([
      'manual-first',
      'automatic-second',
    ]);
    expect(JSON.stringify(outputs[1]!.output)).toContain('automatic captured');
    server.assertExhausted();
  },
);
