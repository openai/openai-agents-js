import { describe, expect, it } from 'vitest';
import { nativeInput, type UserInput } from '../../src/runtime/input';
import { projectHistory, type ThreadHistory } from '../../src/runtime/history';
import { ObservationBuffer } from '../../src/runtime/observation';
import { tokenUsageInfo } from '../../src/runtime/run-events';

const turn = { submissionId: 'submission-1', turnId: 'turn-1' };
const counts = {
  input_tokens: 17,
  cached_input_tokens: 3,
  cache_write_input_tokens: 4,
  output_tokens: 7,
  reasoning_output_tokens: 2,
  total_tokens: 24,
};

describe('Python data API parity', () => {
  it('captures ordered user content and rejects remote images before native submission', () => {
    const input: UserInput = {
      role: 'user',
      content: [
        { type: 'input_text', text: 'before' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,AQ==',
          detail: 'auto',
        },
        { type: 'input_text', text: 'after' },
      ],
    };
    const captured = nativeInput(input);
    input.content = 'changed by caller';
    expect(captured).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', image_url: 'data:image/png;base64,AQ==' },
      { type: 'text', text: 'after' },
    ]);
    expect(() =>
      nativeInput({
        role: 'user',
        content: [
          { type: 'input_text', text: 'must not be partially submitted' },
          { type: 'input_image', image_url: 'https://example.com/image.png' },
        ],
      }),
    ).toThrow(TypeError);
  });

  it('keeps absent usage distinct from zero and snapshots native counts without extra data', () => {
    expect(tokenUsageInfo(null)).toBeNull();
    const raw = {
      total_token_usage: {
        ...counts,
        input_tokens: '9007199254740993',
        secret: 'not-public',
      },
      last_token_usage: { ...counts },
      model_context_window: 100_000,
    };
    const usage = tokenUsageInfo(raw)!;
    raw.last_token_usage.input_tokens = 999;
    expect(usage.totalTokenUsage.inputTokens).toBe(9007199254740993n);
    expect(usage.lastTokenUsage.inputTokens).toBe(17);
    expect(usage.modelContextWindow).toBe(100_000);
    expect(Object.isFrozen(usage.lastTokenUsage)).toBe(true);
    expect(usage.totalTokenUsage).not.toHaveProperty('secret');
  });

  it('projects native tool records and enriches a raw call without duplicating its occurrence', () => {
    const records: ThreadHistory = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn', started_at: 11 },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'raw-item',
          call_id: 'call',
          name: 'lookup',
          arguments: '{"city":"SF"}',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: {
            type: 'DynamicToolCall',
            id: 'call',
            tool: 'lookup',
            arguments: { city: 'SF' },
            status: 'completed',
            success: true,
            content_items: [{ type: 'inputText', text: 'sunny' }],
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: {
            type: 'McpToolCall',
            id: 'mcp',
            server: 'weather',
            tool: 'forecast',
            arguments: {},
            status: 'completed',
            result: { temperature: 18 },
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: {
            type: 'CommandExecution',
            id: 'exec',
            command: ['cat', 'two words'],
            cwd: '/work',
            status: 'completed',
            aggregated_output: 'done',
            exit_code: 0,
            duration: { secs: 1, nanos: 500_000_000 },
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: {
            type: 'CollabAgentToolCall',
            id: 'spawn',
            tool: 'spawn_agent',
            sender_thread_id: 'root',
            receiver_thread_ids: ['child'],
            status: 'completed',
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: 'turn',
          item: {
            type: 'WebSearch',
            id: 'web',
            action: { type: 'openPage', url: 'https://example.com' },
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn',
          last_agent_message: 'not recorded',
          completed_at: 13,
        },
      },
    ];
    const { items } = projectHistory(records, 'root');
    expect(items.map((item) => item.type)).toEqual([
      'function_call',
      'function_call_output',
      'mcp_call',
      'command_execution',
      'create_subagent_call',
      'web_search_call',
    ]);
    expect(items[0]).toMatchObject({
      id: 'call',
      callId: 'call',
      status: 'completed',
      arguments: { city: 'SF' },
    });
    expect(items[1]).toMatchObject({
      callId: 'call',
      output: [{ type: 'input_text', text: 'sunny' }],
    });
    expect(items[2]).toMatchObject({
      serverLabel: 'weather',
      output: { temperature: 18 },
    });
    expect(items[3]).toMatchObject({
      command: "cat 'two words'",
      durationMs: 1500,
      exitCode: 0,
    });
    expect(items[4]).toMatchObject({ agentId: 'root', subagentId: 'child' });
    expect(items[5]).toMatchObject({
      action: { type: 'open_page', url: 'https://example.com' },
    });
  });

  it('retains early usage and fatal failure through terminal history projection', () => {
    const { turns } = projectHistory(
      [
        {
          type: 'token_usage_record',
          payload: { turn_id: 'turn', turn_token_usage: counts },
        },
        {
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn', started_at: 7 },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'error',
            turn_id: 'turn',
            message: 'busy',
            codex_error_info: {
              HttpConnectionFailed: { http_status_code: 503 },
            },
          },
        },
        {
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: 'turn', completed_at: 9 },
        },
      ],
      'root',
      'child',
    );
    expect(turns).toEqual([
      {
        id: 'turn',
        object: 'agent.session.turn',
        sessionId: 'root',
        subagentId: 'child',
        status: 'failed',
        createdAt: 7,
        startedAt: 7,
        completedAt: 9,
        error: {
          code: 'server_overloaded',
          message: 'busy',
          httpStatusCode: 503,
        },
        usage: {
          inputTokens: 17,
          inputTokensDetails: { cachedTokens: 3, cacheWriteTokens: 4 },
          outputTokens: 7,
          outputTokensDetails: { reasoningTokens: 2 },
          totalTokens: 24,
        },
      },
    ]);
  });

  it('gives independent event readers replay cursors and closes only the departing reader', async () => {
    const buffer = new ObservationBuffer('session');
    const a = buffer.events();
    const b = buffer.events();
    const pending = a.next();
    buffer.append({ type: 'turn_started', ...turn });
    expect((await pending).value).toEqual((await b.next()).value);
    await a.return!();
    const replay = buffer.events({ after: 1 });
    buffer.append({
      type: 'output_text_delta',
      ...turn,
      itemId: 'message',
      delta: 'hi',
    });
    expect((await b.next()).value).toEqual((await replay.next()).value);
    buffer.finish('closed');
    expect((await b.next()).value).toMatchObject({
      type: 'session_ended',
      sequence: 3,
    });
    expect(await b.next()).toMatchObject({ done: true });
    expect(await a.next()).toMatchObject({ done: true });
    await replay.return!();
  });

  it('reports evicted and oversized observations as gaps without losing later events', async () => {
    const buffer = new ObservationBuffer('session');
    const reader = buffer.events();
    for (let i = 0; i < 257; i++)
      buffer.append({
        type: 'output_text_delta',
        ...turn,
        itemId: 'message',
        delta: String(i),
      });
    expect((await reader.next()).value).toEqual({
      type: 'gap',
      sessionId: 'session',
      firstSequence: 1,
      sequence: 1,
    });
    expect((await reader.next()).value).toMatchObject({
      type: 'output_text_delta',
      sequence: 2,
      delta: '1',
    });
    buffer.append({
      type: 'output_text_delta',
      ...turn,
      itemId: 'message',
      delta: 'x'.repeat(65_536),
    });
    buffer.append({ type: 'turn_finished', ...turn, status: 'completed' });
    expect((await reader.next()).value).toMatchObject({
      type: 'gap',
      firstSequence: 3,
      sequence: 258,
    });
    expect((await reader.next()).value).toMatchObject({
      type: 'turn_finished',
      sequence: 259,
    });
    await reader.return!();
  });
});
