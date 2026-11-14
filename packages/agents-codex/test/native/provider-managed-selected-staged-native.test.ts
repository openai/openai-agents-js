import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  tool,
  pendingInput,
  withPendingInput,
  parseSessionState,
} from '../../src';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const releases: (() => void)[] = [];
const fronts: Server[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const server of fronts.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
const kept = 'SELECTED_ORIGINAL_OCCURRENCE';
const omitted = 'OMITTED_ORIGINAL_OCCURRENCE';
const live = 'LIVE_BEFORE_PROVIDER_TERMINAL';
function emit(response: ServerResponse, frame: object) {
  response.write('data: ' + JSON.stringify(frame) + '\n\n');
}
function output(response: ServerResponse, item: object, index = 0) {
  emit(response, {
    type: 'response.output_item.done',
    output_index: index,
    item,
  });
}
function message(text: string, id: string) {
  return {
    type: 'message',
    id,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}
async function endpoint(failure: boolean) {
  const requests: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const failures: unknown[] = [];
  const prefix = latch();
  const terminal = latch();
  releases.push(terminal.resolve);
  const server = createServer(async (request, response) => {
    try {
      expect(request.headers.authorization).toBe(
        'Bearer synthetic-selected-staged',
      );
      if (request.method === 'GET') {
        reads.push(request.url!);
        const match = request.url!.match(
          /^\/v1\/(responses|conversations)\/([^/?]+)$/,
        );
        const id = match?.[2];
        if (!id) {
          response.writeHead(404).end('{}');
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            id,
            ...(match?.[1] === 'conversations'
              ? { object: 'conversation' }
              : { status: 'completed' }),
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const index = requests.length - 1;
      const id = 'response-' + (index + 1);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      emit(response, { type: 'response.created', response: { id } });
      if (index === 0) {
        output(response, {
          type: 'function_call',
          name: 'decision',
          call_id: 'original-decision',
          arguments: '{}',
        });
      } else if (index === 1) {
        emit(response, {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'message',
            id: 'live-message',
            role: 'assistant',
            content: [],
          },
        });
        emit(response, {
          type: 'response.output_text.delta',
          item_id: 'live-message',
          output_index: 0,
          content_index: 0,
          delta: live,
        });
        output(response, message(live, 'live-message'));
        output(
          response,
          {
            type: 'function_call',
            name: 'effect',
            call_id: 'current-effect',
            arguments: '{}',
          },
          1,
        );
        prefix.resolve();
        await terminal.promise;
        if (failure) {
          emit(response, {
            type: 'response.failed',
            response: {
              id,
              error: {
                code: 'fixture_failed',
                message: 'Selected terminal fixture failure',
              },
            },
          });
          response.end();
          return;
        }
      } else
        output(
          response,
          message(index === 2 ? 'settled' : 'drained', 'answer-' + index),
        );
      emit(response, { type: 'response.completed', response: { id } });
      response.end();
    } catch (error) {
      failures.push(error);
      response.destroy(error as Error);
    }
  });
  fronts.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return {
    requests,
    reads,
    failures,
    prefix,
    terminal,
    baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
  };
}

const historyKinds = ['previous_response', 'conversation'] as const;
const modes = [
  'selected-success',
  'selected-failure',
  'selected-cancel',
  'ordinary-early',
] as const;
it.each(
  historyKinds.flatMap((historyKind) =>
    modes.map((mode) => ({ historyKind, mode })),
  ),
)(
  'has been preserving staged terminal ownership and live observations ($historyKind, $mode)',
  async ({ historyKind, mode }) => {
    const authorization = (id?: string) =>
      historyKind === 'conversation'
        ? { type: 'conversation' as const, id: 'conv_selected_staged' }
        : { type: 'previous_response' as const, ...(id ? { id } : {}) };
    const selected = mode !== 'ordinary-early';
    const failed = mode === 'selected-failure';
    const cancelled = mode === 'selected-cancel';
    const remote = await endpoint(failed);
    const effects: string[] = [];
    await using provider = new NativeProvider({
      baseUrl: remote.baseUrl,
      apiKey: 'synthetic-selected-staged',
      supportsWebsockets: false,
    });
    let omit = true;
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      modelSettings: { store: true },
      instructions: 'Answer after each decision.',
      tools: [
        manualTool({
          name: 'decision',
          description: 'Owned decision',
          parameters: z.object({}),
          result: z.string(),
        }),
        tool({
          name: 'effect',
          description: 'Record one owned execution',
          parameters: z.object({}),
          execute() {
            effects.push('effect');
            return 'effect-result';
          },
        }),
      ],
      transformContext: ({ items }) =>
        omit
          ? items.filter((item) => !JSON.stringify(item).includes(omitted))
          : items,
    });
    await using source = await agent.session({
      providerHistory: authorization(),
    });
    const original = await source.submit('original');
    const stopped = original.wait().catch((error: unknown) => error);
    await original.wait({ until: 'manual_tool' });
    const saved = withPendingInput(
      withPendingInput(await source.suspend(), kept),
      omitted,
    );
    await stopped;
    await source.close();
    const portable = parseSessionState(JSON.stringify(saved));
    const originalBytes = JSON.stringify(portable);
    await using resumed = await agent.session({
      state: portable,
      providerHistory: authorization('response-1'),
      ...(selected
        ? { pendingInputAdmission: 'selected-before-send' as const }
        : {}),
      observationRetention: 'all',
    });
    const turn = resumed.restoredTurn!;
    const delta = latch();
    const observations = (async () => {
      for await (const event of turn.events())
        if (event.type === 'output_text_delta' && event.delta === live)
          delta.resolve();
    })();
    const settled = turn.wait().then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const action = (await resumed.pendingInteractions())[0];
    if (action?.type !== 'action_requested')
      throw new Error('Missing owned decision');
    try {
      await resumed.respond(action.reply('accepted-decision'));
      await Promise.race([
        remote.prefix.promise,
        settled.then((outcome) => {
          throw (
            outcome.error ?? new Error('Turn settled before streaming prefix')
          );
        }),
      ]);
      await Promise.race([
        delta.promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Live delta waited for terminal')),
            5_000,
          ),
        ),
      ]);
      expect(JSON.stringify(remote.requests[1].input)).toContain(kept);
      expect(JSON.stringify(remote.requests[1].input)).not.toContain(omitted);
      expect(
        remote.requests[1][
          historyKind === 'conversation'
            ? 'conversation'
            : 'previous_response_id'
        ],
      ).toBe(
        historyKind === 'conversation' ? 'conv_selected_staged' : 'response-1',
      );
      if (selected) expect(effects).toEqual([]);
      else await vi.waitFor(() => expect(effects).toEqual(['effect']));
      if (cancelled) await turn.cancel();
    } finally {
      remote.terminal.resolve();
    }
    const result = await settled;
    await observations;
    expect(JSON.stringify(portable)).toBe(originalBytes);
    expect(remote.reads).toContain(
      historyKind === 'conversation'
        ? '/v1/conversations/conv_selected_staged'
        : '/v1/responses/response-1',
    );
    expect(remote.failures).toEqual([]);
    if (failed || cancelled) {
      expect(result.error).toBeDefined();
      expect(effects).toEqual([]);
      const retry = await resumed.saveState();
      expect(pendingInput(retry)).toHaveLength(2);
      expect(JSON.stringify(retry.history)).not.toContain(kept);
      expect(JSON.stringify(retry.history)).not.toContain(live);
      expect(remote.requests).toHaveLength(2);
      return;
    }
    expect(result.error).toBeUndefined();
    expect(result.value?.finalOutput).toBe('settled');
    expect(effects).toEqual(['effect']);
    const completed = await resumed.saveState();
    if (!selected) {
      expect(pendingInput(completed)).toEqual([]);
      return;
    }
    expect(pendingInput(completed)).toHaveLength(1);
    const history = JSON.stringify(completed.history);
    expect(history).toContain(kept);
    expect(history).not.toContain(omitted);
    const canonical = completed.history.filter(
      (row) => row.type === 'response_item',
    );
    const selectedIndex = canonical.findIndex((row) =>
      JSON.stringify(row).includes(kept),
    );
    const outputIndex = canonical.findIndex((row) =>
      JSON.stringify(row).includes(live),
    );
    expect(selectedIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(selectedIndex).toBeLessThan(outputIndex);
    await resumed.close();
    omit = false;
    await using cold = await agent.session({
      state: parseSessionState(JSON.stringify(completed)),
      providerHistory: authorization('response-3'),
      pendingInputAdmission: 'selected-before-send',
    });
    expect((await (await cold.submit('')).wait()).finalOutput).toBe('drained');
    expect(
      remote.requests[3][
        historyKind === 'conversation' ? 'conversation' : 'previous_response_id'
      ],
    ).toBe(
      historyKind === 'conversation' ? 'conv_selected_staged' : 'response-3',
    );
    expect(
      (remote.requests[3].input as unknown[]).filter((item) =>
        JSON.stringify(item).includes(omitted),
      ),
    ).toHaveLength(1);
    expect(pendingInput(await cold.saveState())).toEqual([]);
    expect(effects).toEqual(['effect']);
    expect(remote.requests).toHaveLength(4);
  },
  30_000,
);
