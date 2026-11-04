import { describe, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import {
  projectExecutionItem,
  projectHistory,
  type ThreadHistory,
} from '../../src/runtime/history';
describe('native history projection', () => {
  it('keeps canonical command, patch and MCP completions without a start record', () => {
    const rawItems: JsonObject[] = [
      {
        type: 'CommandExecution',
        id: 'command-1',
        command: ['/bin/sh', '-c', "printf '%s' 'a b'"],
        cwd: '/workspace',
        status: 'failed',
        aggregated_output: 'denied',
      },
      {
        type: 'FileChange',
        id: 'patch-1',
        changes: {
          '/workspace/example': {
            type: 'update',
            unified_diff: '- old\n+ new',
            move_path: null,
          },
        },
        status: 'completed',
      },
      {
        type: 'McpToolCall',
        id: 'mcp-1',
        server: 'fixture',
        tool: 'lookup',
        arguments: { query: 'a b' },
        result: { content: [{ type: 'text', text: 'result' }] },
        status: 'completed',
      },
    ];
    const records: ThreadHistory = [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      ...rawItems.map((item) => ({
        type: 'event_msg' as const,
        payload: {
          type: 'item_completed',
          thread_id: 'root',
          turn_id: 'turn',
          item,
        },
      })),
      {
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'turn' },
      },
    ];
    const retained = projectHistory(records, 'portable-copy').items.map(
      ({ data: _data, ...item }) => item,
    );
    expect(retained).toEqual(
      rawItems.map((item) => projectExecutionItem(item, 'turn', 'root')),
    );
    expect(retained).toMatchObject([
      {
        type: 'command_execution',
        argv: rawItems[0]!.command,
        output: 'denied',
        status: 'failed',
        threadId: 'root',
        turnId: 'turn',
        callId: 'command-1',
      },
      {
        type: 'file_change',
        changes: {
          '/workspace/example': {
            type: 'update',
            unifiedDiff: '- old\n+ new',
            movePath: null,
          },
        },
        threadId: 'root',
        turnId: 'turn',
        callId: 'patch-1',
      },
      {
        type: 'mcp_call',
        arguments: { query: 'a b' },
        threadId: 'root',
        turnId: 'turn',
        callId: 'mcp-1',
      },
    ]);
  });

  it('does not invent messages from a turn completion and removes rolled back pairs', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't1', started_at: 1 },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{}',
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 't1',
          last_agent_message: 'not recorded',
        },
      },
      { type: 'turn_context', payload: { turn_id: 't2' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
      {
        type: 'response_item',
        payload: { type: 'message', id: 'm2', role: 'user', content: [] },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2' } },
      {
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
    ];
    const projected = projectHistory(records, 'root');
    expect(projected.turns.map((t) => [t.id, t.status])).toEqual([
      ['t1', 'completed'],
    ]);
    expect(projected.items.map((i) => i.id)).toEqual(['c1', 'c1:output']);
  });

  it.each([
    ['function_call', 'function_call_output'],
    ['custom_tool_call', 'custom_tool_call_output'],
  ])('preserves repeated %s receipts and distinct cursors', (call, output) => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        type: 'response_item',
        payload: {
          type: call,
          call_id: 'c1',
          name: 'lookup',
          arguments: 'first',
        },
      },
      {
        type: 'response_item',
        payload: { type: output, call_id: 'c1', output: 'first receipt' },
      },
      {
        type: 'response_item',
        payload: {
          type: call,
          call_id: 'c1',
          name: 'lookup',
          arguments: 'second',
        },
      },
      {
        type: 'response_item',
        payload: { type: output, call_id: 'c1', output: 'second receipt' },
      },
      // Recorded IDs have precedence over synthetic cursors, even if observed later.
      {
        type: 'response_item',
        payload: { type: 'message', id: 'c1', role: 'user', content: [] },
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    ];
    const { items } = projectHistory(records, 'root');
    expect(items.map((item) => item.data)).toEqual(
      records
        .filter((record) => record.type === 'response_item')
        .map((record) => record.payload),
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(5);
    expect(items.at(-1)?.id).toBe('c1');
  });

  it('accepts only a late receipt owned by the just-aborted turn and forgets rolled back ownership', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{}',
        },
      },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'unowned',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'other',
          output: 'other',
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'cancel receipt',
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
    ];
    const projected = projectHistory(records, 'root');
    expect(projected.turns).toMatchObject([{ id: 't1', status: 'cancelled' }]);
    expect(projected.items.map((item) => item.data.output)).toEqual([
      undefined,
      'cancel receipt',
    ]);
    records.push(
      {
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'after rollback',
          internal_chat_message_metadata_passthrough: { turn_id: 't1' },
        },
      },
    );
    expect(projectHistory(records, 'root')).toEqual({ turns: [], items: [] });
  });
});

// Captured packed-consumer rollout ordinals 8-9 record this single input twice.
describe('accepted user input history', () => {
  it('projects the captured Responses/native pair as one native user message', () => {
    const turnId = '01a194cf-13bc-70f3-93c2-e0f7650fd8ed';
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: turnId } },
      recordedUser(
        'msg_01a194cf-13f2-7a30-8cdd-4bc5f86d8bad',
        turnId,
        'package-cjs-first-prompt',
        0,
      ),
      nativeUser(
        '01a194cf-13f2-7a30-8cdd-4bde5eaa0b17',
        turnId,
        'package-cjs-first-prompt',
      ),
    ];
    expect(projectHistory(records, 'root').items).toMatchObject([
      {
        id: '01a194cf-13f2-7a30-8cdd-4bde5eaa0b17',
        turnId,
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'package-cjs-first-prompt' }],
      },
    ]);
    expect(projectHistory(records, 'root').items).toHaveLength(1);
  });

  it('keeps repeated equal input and multiple steering occurrences in their recorded order', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'again', 0),
      nativeUser('n1', 't1', 'again'),
      recordedUser('r2', 't1', 'again', 1),
      nativeUser('n2', 't1', 'again'),
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
      { type: 'turn_context', payload: { turn_id: 't2' } },
      recordedUser('r3', 't2', 'again', 2),
      nativeUser('n3', 't2', 'again'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => [
        item.id,
        item.turnId,
      ]),
    ).toEqual([
      ['n1', 't1'],
      ['n2', 't1'],
      ['n3', 't2'],
    ]);
    expect(projectHistory(JSON.parse(JSON.stringify(records)), 'root')).toEqual(
      projectHistory(records, 'root'),
    );
  });

  it('excludes internal context, image notices and acceptance-marked user goals from pairing', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('steering', 't1', 'continue', undefined, [
        'agents_steering.internal_context',
      ]),
      recordedUser('r1', 't1', 'input', 0),
      recordedUser('resize', 't1', 'resized', undefined, [
        'images.resize_notice',
      ]),
      recordedUser('goal', 't1', 'goal', 1, ['user.goal']),
      nativeUser('n1', 't1', 'input'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['steering', 'resize', 'goal', 'n1']);
  });

  it('does not let lifecycle repeats consume the next input candidate', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'first', 0),
      nativeUser('n1', 't1', 'first', 'item_started'),
      nativeUser('n1', 't1', 'first'),
      recordedUser('r2', 't1', 'second', 1),
      nativeUser('n1', 't1', 'first'),
      nativeUser('n2', 't1', 'second'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['n1', 'n2']);
  });

  it('keeps a shared recorded ID once when native and Responses IDs already agree', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('same', 't1', 'input', 0),
      nativeUser('same', 't1', 'input'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['same']);
  });

  it.each([false, true])(
    'pairs image preparation errors with mixed text %s',
    (withText) => {
      const response = recordedUser(
        'r1',
        't1',
        'Image could not be processed.',
        0,
        withText
          ? ['user.text', 'images.preparation_error']
          : ['images.preparation_error'],
      );
      if (withText)
        response.payload.content = [
          { type: 'input_text', text: 'describe this' },
          { type: 'input_text', text: 'Image could not be processed.' },
        ];
      const native = nativeUser('n1', 't1', '');
      native.payload.item = {
        type: 'UserMessage',
        id: 'n1',
        content: [
          ...(withText ? [{ type: 'text', text: 'describe this' }] : []),
          { type: 'image', image_url: 'data:image/png;base64,AQ==' },
        ],
      };
      const { items } = projectHistory(
        [
          { type: 'turn_context', payload: { turn_id: 't1' } },
          response,
          native,
        ],
        'root',
      );
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: 'n1',
        type: 'message',
        role: 'user',
        content: [
          ...(withText ? [{ type: 'input_text', text: 'describe this' }] : []),
          { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
        ],
        data: native.payload.item,
      });
    },
  );

  it('keeps native attachment content and order without comparing prepared content', () => {
    const response = recordedUser('r1', 't1', 'prepared', 0, [
      'user.text',
      'user.image',
    ]);
    response.payload.content = [
      { type: 'input_text', text: 'prepared' },
      { type: 'input_image', image_url: 'prepared-image' },
    ];
    const native = nativeUser('n1', 't1', 'original');
    native.payload.item = {
      type: 'UserMessage',
      id: 'n1',
      content: [
        { type: 'text', text: 'original' },
        { type: 'image', image_url: 'data:image/png;base64,AQ==' },
        { type: 'text', text: 'last' },
      ],
    };
    const { items } = projectHistory(
      [{ type: 'turn_context', payload: { turn_id: 't1' } }, response, native],
      'root',
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'n1',
      content: [
        { type: 'input_text', text: 'original' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQ==' },
        { type: 'input_text', text: 'last' },
      ],
      data: native.payload.item,
    });
  });

  it.each<ThreadHistory[number]>([
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
    { type: 'turn_context', payload: { turn_id: 'other' } },
    { type: 'compacted', payload: {} },
    {
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        turn_id: 't1',
        item: { type: 'ContextCompaction', id: 'compact' },
      },
    },
  ])('does not associate across boundary %j', (boundary) => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'input', 0),
      boundary,
      nativeUser('n1', 't1', 'input'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['r1', 'n1']);
  });

  it('retains an unmatched earlier input when a second accepted input arrives', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'unmatched', 0),
      recordedUser('r2', 't1', 'paired', 1),
      nativeUser('n2', 't1', 'paired'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['r1', 'n2']);
  });

  it.each([
    [undefined, ['user.text']],
    [-1, ['user.text']],
    [0.5, ['user.text']],
    [0, ['user.goal']],
    [0, ['unknown']],
    [0, ['user.text', 'user.goal']],
  ] as const)(
    'retains unmarked or contextual records with order %s and kinds %j',
    (order, kinds) => {
      const records: ThreadHistory = [
        { type: 'turn_context', payload: { turn_id: 't1' } },
        recordedUser('r1', 't1', 'input', order, [...kinds]),
        nativeUser('n1', 't1', 'input'),
      ];
      expect(
        projectHistory(records, 'root').items.map((item) => item.id),
      ).toEqual(['r1', 'n1']);
    },
  );

  it('leaves a Responses record with a foreign payload turn unmatched', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 'foreign', 'input', 0),
      nativeUser('n1', 't1', 'input'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['r1', 'n1']);
  });

  it('shows unmatched snapshots and selects the native ID when its partner arrives', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'input', 0),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['r1']);
    records.push(nativeUser('n1', 't1', 'input'));
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['n1']);
    expect(
      projectHistory([records[0]!, records[2]!], 'root').items.map(
        (item) => item.id,
      ),
    ).toEqual(['n1']);
  });

  it('forgets paired and pending input on rollback before reusing recorded identities', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'input', 0),
      nativeUser('n1', 't1', 'input'),
      recordedUser('pending', 't1', 'unmatched', 1),
      {
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('r1', 't1', 'new input', 2),
      nativeUser('n1', 't1', 'new input'),
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['n1']);
  });

  it('preserves cursor suffix indices and reservations for suppressed recorded IDs', () => {
    const records: ThreadHistory = [
      { type: 'turn_context', payload: { turn_id: 't1' } },
      recordedUser('c1', 't1', 'input', 0),
      nativeUser('n1', 't1', 'input'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'first',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          name: 'lookup',
          arguments: '{}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: 'second',
        },
      },
    ];
    expect(
      projectHistory(records, 'root').items.map((item) => item.id),
    ).toEqual(['n1', 'c1:2', 'c1:output', 'c1:4', 'c1:output:5']);
  });
});

function recordedUser(
  id: string,
  turnId: string,
  text: string,
  order?: number,
  kinds = ['user.text'],
): ThreadHistory[number] {
  return {
    type: 'response_item',
    payload: {
      type: 'message',
      id,
      role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: {
        turn_id: turnId,
        content_item_kinds: kinds,
      },
    },
    ...(order === undefined ? {} : { metadata: { user_input_order: order } }),
  };
}

function nativeUser(
  id: string,
  turnId: string,
  text: string,
  type = 'item_completed',
): ThreadHistory[number] {
  return {
    type: 'event_msg',
    payload: {
      type,
      turn_id: turnId,
      item: { type: 'UserMessage', id, content: [{ type: 'text', text }] },
    },
  };
}
