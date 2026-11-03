import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  type Observation,
  type SessionItem,
} from '@openai/agents';
import {
  vercelResponse,
  ownedVercelResponse,
} from '../../examples/native-ui/vercel';
import { agUiResponse } from '../../examples/native-ui/ag-ui';
import type {
  ViewSession,
  ViewTurn,
} from '../../examples/native-ui/projection';

const identity = { sessionId: 's', submissionId: 'owned', turnId: 't' };
const start: Observation = { ...identity, sequence: 1, type: 'turn_started' };
const delta = (
  itemId: string,
  text: string,
): Extract<Observation, { type: 'output_text_delta' }> => ({
  ...identity,
  sequence: 2,
  type: 'output_text_delta',
  itemId,
  delta: text,
});
function fixture(events: Observation[], text = 'hello', error?: Error) {
  const turn: ViewTurn<string> = {
    ...identity,
    childId: null,
    events: () =>
      (async function* () {
        yield* events;
      })(),
    async wait() {
      if (error) throw error;
      return { finalOutput: text };
    },
  };
  const item: SessionItem = {
    type: 'message',
    id: 'native-item',
    turnId: 't',
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
  const session: ViewSession = {
    id: 's',
    async *items() {
      yield item;
    },
  };
  return { turn, session };
}
async function frames(response: Response) {
  return (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((line) => line.slice(6))
    .map((line) => (line === '[DONE]' ? line : JSON.parse(line)));
}

describe('fresh native UI wire subset', () => {
  it('emits Vercel native IDs and transient allowlisted progress in order', async () => {
    const progress: Observation = {
      ...identity,
      sequence: 2,
      type: 'tool_started',
      callId: 'call',
      name: 'lookup',
      namespace: null,
      family: 'function',
    };
    const { turn, session } = fixture([
      start,
      progress,
      delta('native-item', 'hello'),
    ]);
    const response = vercelResponse(turn, session);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await frames(response)).toEqual([
      { type: 'start' },
      {
        type: 'data-tool-progress',
        transient: true,
        data: {
          type: 'tool_started',
          call_id: 'call',
          name: 'lookup',
          namespace: null,
          family: 'function',
        },
      },
      { type: 'text-start', id: 'native-item' },
      { type: 'text-delta', id: 'native-item', delta: 'hello' },
      { type: 'text-end', id: 'native-item' },
      { type: 'finish' },
      '[DONE]',
    ]);
  });
  it('emits AG-UI identity and excludes empty deltas and Vercel markers', async () => {
    const { turn, session } = fixture([
      start,
      delta('empty', ''),
      delta('native-item', 'hello'),
    ]);
    const response = agUiResponse(turn, session, undefined);
    expect(response.headers.has('x-vercel-ai-ui-message-stream')).toBe(false);
    expect(await frames(response)).toEqual([
      { type: 'RUN_STARTED', threadId: 's', runId: 'owned' },
      {
        type: 'TEXT_MESSAGE_START',
        messageId: 'native-item',
        role: 'assistant',
      },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'native-item',
        delta: 'hello',
      },
      { type: 'TEXT_MESSAGE_END', messageId: 'native-item' },
      { type: 'RUN_FINISHED', threadId: 's', runId: 'owned' },
    ]);
  });
  it.each(['gap', 'second-start', 'missing-start', 'done-only'] as const)(
    'Vercel refuses incomplete %s without fabricating text',
    async (kind) => {
      const events =
        kind === 'gap'
          ? [
              start,
              {
                type: 'gap' as const,
                sessionId: 's',
                sequence: 8,
                firstSequence: 2,
              },
            ]
          : kind === 'second-start'
            ? [start, { ...start, turnId: 'next' }]
            : kind === 'missing-start'
              ? [delta('native-item', 'hello')]
              : [start];
      const { turn, session } = fixture(events);
      const result = await frames(vercelResponse(turn, session));
      expect(result).toContainEqual({
        type: 'error',
        errorText: 'resync_required',
      });
      expect(result).not.toContainEqual({ type: 'finish' });
      expect(result.filter((row) => row.type === 'text-delta')).toEqual([]);
    },
  );
  it('ignores unrelated early loss when exact start is retained', async () => {
    const { turn, session } = fixture([
      { type: 'gap', sessionId: 's', sequence: 9, firstSequence: 1 },
      start,
      delta('native-item', 'hello'),
    ]);
    expect(await frames(vercelResponse(turn, session))).toContainEqual({
      type: 'finish',
    });
  });
  it('AG-UI permits an owned continuation, while verifying the last native identity', async () => {
    const { turn } = fixture([
      start,
      { ...start, turnId: 'next' },
      { ...delta('last-item', 'hello'), turnId: 'next' },
    ]);
    const session: ViewSession = {
      id: 's',
      async *items() {
        yield {
          type: 'message',
          id: 'last-item',
          turnId: 'next',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello' }],
        };
      },
    };
    expect(await frames(agUiResponse(turn, session, undefined))).toContainEqual(
      { type: 'RUN_FINISHED', threadId: 's', runId: 'owned' },
    );
  });
  it('does not publish success on a terminal observation before settlement', async () => {
    const finished: Observation = {
      ...identity,
      sequence: 3,
      type: 'turn_finished',
      status: 'completed',
    };
    const { turn, session } = fixture(
      [start, delta('native-item', 'hello'), finished],
      'hello',
      new Error('secret callback detail'),
    );
    const wire = await vercelResponse(turn, session).text();
    expect(wire).toContain('turn_failed');
    expect(wire).not.toContain('secret callback detail');
    expect(wire).not.toContain('"type":"finish"');
  });
  it('reports stop-related errors neutrally without raw causes', async () => {
    const error = new NativeError('secret', {
      cause: new Error('nested secret'),
    });
    error.name = 'TurnAborted';
    const { turn, session } = fixture([start], '', error);
    expect(await frames(vercelResponse(turn, session))).toContainEqual({
      type: 'abort',
    });
    expect(await frames(agUiResponse(turn, session, undefined))).toContainEqual(
      {
        type: 'RUN_ERROR',
        code: 'turn_cancelled',
        message: 'The turn ended with a stop-related error.',
      },
    );
  });
  it('projects matched child cancellation only after settlement with child thread identity', async () => {
    const error = new NativeError('private child failure');
    const terminal: Observation = {
      ...identity,
      sequence: 3,
      type: 'turn_finished',
      status: 'cancelled',
    };
    const { turn, session } = fixture([start, terminal], '', error);
    const child = { ...turn, childId: 'native-child' };
    const wire = await frames(agUiResponse(child, session, undefined));
    expect(wire[0]).toEqual({
      type: 'RUN_STARTED',
      threadId: 'native-child',
      runId: 'owned',
    });
    expect(wire).toContainEqual({
      type: 'RUN_ERROR',
      code: 'turn_cancelled',
      message: 'The turn ended with a stop-related error.',
    });
    expect(JSON.stringify(wire)).not.toContain('private child failure');
  });

  it('cancelled work with no native start is not misreported as history loss', async () => {
    const error = new NativeError('queued stop');
    error.name = 'TurnAborted';
    const { turn, session } = fixture([], '', error);
    const queued = { ...turn, turnId: null };
    expect(await frames(vercelResponse(queued, session))).toContainEqual({
      type: 'abort',
    });
  });

  it.each([z.string(), { mode: 'prompted' as const, schema: z.string() }])(
    'rejects nondefault output before opening the owned Session',
    async (outputType) => {
      const open = vi.spyOn(Agent.prototype, 'session');
      try {
        const agent = new Agent<undefined>({
          instructions: 'Answer.',
          outputType,
        });
        await expect(ownedVercelResponse(agent, 'Run')).rejects.toThrow(
          'Plain default Agent output required',
        );
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    },
  );

  it('rejects a foreign Session before making a response', () => {
    const { turn, session } = fixture([start]);
    expect(() => vercelResponse(turn, { ...session, id: 'foreign' })).toThrow(
      'owning Session',
    );
  });
});
