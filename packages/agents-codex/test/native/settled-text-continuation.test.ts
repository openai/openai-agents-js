import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  OutputValidationError,
  type ApprovalRequest,
  type Completed,
} from '@openai/agents';
import { continueCompletedText } from '../../../../examples/codex/settled-text-continuation';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
    supportsWebsockets: false,
  });
}

async function beforeSettlement<T>(
  observation: Promise<T>,
  run: Promise<unknown>,
) {
  return Promise.race([
    observation,
    run.then(() => {
      throw new Error('Loop settled before the expected observation');
    }),
  ]);
}

const deny = async () => 'deny' as const;
const native = describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

native('application-owned completed-text continuation', () => {
  it('continues with a new Turn in the original Session, then finishes', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('Needs revision')];
      },
      [message('Finished answer')],
      [message('Separate conversation')],
    ]);
    await using provider = await providerFor(model);
    const agent = new Agent({ instructions: 'Answer briefly.', provider });
    await using session = await agent.session();
    const submit = vi.spyOn(session, 'submit');
    const seen: Completed<string>[] = [];
    const choose = vi.fn(async (completed: Completed<string>) => {
      seen.push(completed);
      return completed.finalOutput === 'Needs revision' ? 'Revise it.' : null;
    });
    const run = continueCompletedText(session, 'Draft an answer.', {
      signal: AbortSignal.timeout(10_000),
      approve: deny,
      choose,
    });
    try {
      await beforeSettlement(entered.promise, run);
      expect(choose).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    const results = await run;
    expect(results.map((result) => result.finalOutput)).toEqual([
      'Needs revision',
      'Finished answer',
    ]);
    expect(seen).toEqual(results);
    const first = await submit.mock.results[0]!.value;
    const second = await submit.mock.results[1]!.value;
    expect(results[0]!.turn).toBe(first);
    expect(results[1]!.turn).toBe(second);
    expect(first).not.toBe(second);
    expect(first.sessionId).toBe(session.id);
    expect(second.sessionId).toBe(session.id);
    expect(first.turnId).not.toBe(second.turnId);
    expect(first.submissionId).not.toBe(second.submissionId);
    expect(await first.wait()).toBe(results[0]);
    expect(submit.mock.calls).toEqual([
      ['Draft an answer.', { ifBusy: 'reject' }],
      ['Revise it.', { ifBusy: 'reject' }],
    ]);
    expect(JSON.stringify(model.requests[1])).toContain('Needs revision');
    expect(JSON.stringify(model.requests[1])).toContain('Revise it.');

    await using other = await agent.session();
    const separate = await continueCompletedText(other, 'A separate answer.', {
      signal: AbortSignal.timeout(10_000),
      approve: deny,
      choose: async () => null,
    });
    expect(other.id).not.toBe(session.id);
    expect(separate[0]!.turn.sessionId).toBe(other.id);
    expect(separate[0]!.turn.turnId).not.toBe(first.turnId);
    expect(submit).toHaveBeenCalledTimes(2);
    model.assertExhausted();
  });

  it('handles an original pending approval before choosing completed text', async () => {
    const executor = await startPublicExecutor();
    const target = resolve(executor.cwd, '..', `text-loop-${randomUUID()}`);
    const model = new ModelServer([
      [
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'text-loop-patch',
          input: `*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch`,
        },
      ],
      [message('The application declined the patch.')],
    ]);
    const pending = Promise.withResolvers<ApprovalRequest>();
    const decide = Promise.withResolvers<void>();
    try {
      await using provider = await providerFor(model);
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        // This case exercises native escalation, which strict policy refuses.
        writePolicy: 'legacy',
        tools: ['apply_patch'],
      });
      await using session = await new Agent({
        instructions: 'Apply the requested patch.',
        model: 'gpt-5.5',
        provider,
      }).session({ environment });
      const submit = vi.spyOn(session, 'submit');
      const choose = vi.fn(async () => null);
      const run = continueCompletedText(session, 'Write the proof.', {
        signal: AbortSignal.timeout(10_000),
        choose,
        approve: async (request) => {
          pending.resolve(request);
          await decide.promise;
          return 'deny';
        },
      });
      const request = await beforeSettlement(pending.promise, run);
      try {
        const original = await submit.mock.results[0]!.value;
        expect(request.sessionId).toBe(session.id);
        expect(request.turnId).toBe(original.turnId);
        expect(request.subagentId).toBeNull();
        expect(request.description).toContain(target);
        expect(await session.pendingInteractions()).toEqual([request]);
        expect(choose).not.toHaveBeenCalled();
        expect(submit).toHaveBeenCalledTimes(1);
        await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        decide.resolve();
      }
      const results = await run;
      expect(results[0]!.turn).toBe(await submit.mock.results[0]!.value);
      expect(results[0]!.finalOutput).toBe(
        'The application declined the patch.',
      );
      expect(choose).toHaveBeenCalledTimes(1);
      expect(await session.pendingInteractions()).toEqual([]);
      expect(() => request.reply('allow_once')).toThrow('expired');
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      model.assertExhausted();
    } finally {
      decide.resolve();
      await executor.close();
    }
  });

  it('stops on a provider error without choosing or submitting another Turn', async () => {
    const model = new ModelServer([{ status: 400, body: 'Fixture refusal' }]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Answer briefly.',
      provider,
    }).session();
    const submit = vi.spyOn(session, 'submit');
    const choose = vi.fn(async () => 'Never submit this.');
    await expect(
      continueCompletedText(session, 'Fail this request.', {
        signal: AbortSignal.timeout(10_000),
        choose,
        approve: deny,
      }),
    ).rejects.toThrow();
    expect(choose).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    const original = await submit.mock.results[0]!.value;
    await expect(original.wait()).rejects.toThrow();
    model.assertExhausted();
  });

  it('does not choose from visible text whose completed output fails validation', async () => {
    // ModelServer emits complete items only; this case needs real streamed deltas.
    const text = '{"response":"Short"}';
    let requests = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the actual native request before replying.
      }
      requests++;
      const item = { ...message(text), id: 'visible-invalid-item' };
      const send = (event: unknown) =>
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      send({ type: 'response.created', response: { id: 'visible-invalid' } });
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, content: [] },
      });
      send({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({
        type: 'response.completed',
        response: { id: 'visible-invalid', output: [item] },
      });
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No fixture port');
      await using provider = new NativeProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'fixture',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions: 'Return the requested string.',
        provider,
        outputType: z.string().min(20),
      }).session();
      const submit = vi.spyOn(session, 'submit');
      const choose = vi.fn(async () => 'Never submit this.');
      const run = continueCompletedText(session, 'Produce text.', {
        signal: AbortSignal.timeout(10_000),
        approve: deny,
        choose,
      });
      const rejected = expect(run).rejects.toBeInstanceOf(
        OutputValidationError,
      );
      const original = await submit.mock.results[0]!.value;
      let visible = '';
      for await (const event of original.events()) {
        if (event.type === 'output_text_delta') visible += event.delta;
      }
      await rejected;
      expect(visible).toBe(text);
      expect(choose).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('cancels and joins the original Turn without choosing or submitting again', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const model = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('Late text')];
      },
    ]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Answer briefly.',
      provider,
    }).session();
    const submit = vi.spyOn(session, 'submit');
    const controller = new AbortController();
    const reason = new Error('Application stopped before completion');
    const choose = vi.fn(async () => 'Never submit this.');
    const run = continueCompletedText(session, 'Wait for text.', {
      signal: controller.signal,
      choose,
      approve: deny,
    });
    const rejected = expect(run).rejects.toBe(reason);
    try {
      await beforeSettlement(entered.promise, run);
      controller.abort(reason);
      await rejected;
      const original = await submit.mock.results[0]!.value;
      await expect(original.wait()).rejects.toThrow();
      expect(choose).not.toHaveBeenCalled();
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    model.assertExhausted();
  });

  it('rechecks cancellation after the chooser before submitting its next input', async () => {
    const model = new ModelServer([[message('Completed text')]]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Answer briefly.',
      provider,
    }).session();
    const submit = vi.spyOn(session, 'submit');
    const controller = new AbortController();
    const choosing = Promise.withResolvers<Completed<string>>();
    const answer = Promise.withResolvers<string>();
    const reason = new Error('Application stopped during its chooser');
    const run = continueCompletedText(session, 'Complete once.', {
      signal: controller.signal,
      approve: deny,
      choose: async (completed) => {
        choosing.resolve(completed);
        return answer.promise;
      },
    });
    const rejected = expect(run).rejects.toBe(reason);
    const completed = await beforeSettlement(choosing.promise, run);
    controller.abort(reason);
    answer.resolve('This late choice must not submit.');
    await rejected;
    expect(await completed.turn.wait()).toBe(completed);
    expect(submit).toHaveBeenCalledTimes(1);
    model.assertExhausted();
  });

  it('bounds the outer application loop even when the chooser wants to continue', async () => {
    const model = new ModelServer([[message('One completed root')]]);
    await using provider = await providerFor(model);
    await using session = await new Agent({
      instructions: 'Answer briefly.',
      provider,
    }).session();
    const submit = vi.spyOn(session, 'submit');
    await expect(
      continueCompletedText(session, 'Complete once.', {
        signal: AbortSignal.timeout(10_000),
        approve: deny,
        choose: async () => 'Another root is not allowed.',
        maxTurns: 1,
      }),
    ).rejects.toThrow('Application turn limit reached');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      (await (await submit.mock.results[0]!.value).wait()).finalOutput,
    ).toBe('One completed root');
    model.assertExhausted();
  });
});
