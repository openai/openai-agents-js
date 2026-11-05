import { describe, expect, it } from 'vitest';
import {
  recordedTurnFromWire,
  recordedTurnToWire,
  projectHistory,
  repairItemFromWire,
  repairItemWireSchema,
  repairTurnWireSchema,
  type RecordedTurn,
} from '../../src/runtime/history';
import type { JsonObject } from '../../src/runtime/binding';
import {
  ObservationBuffer,
  type Observation,
  type ObservationOptions,
} from '../../src/runtime/observation';

const original = {
  submissionId: 'original-submission',
  turnId: 'original-turn',
};
const repair = { submissionId: 'repair-submission', turnId: 'repair-turn' };

async function events(buffer: ObservationBuffer): Promise<Observation[]> {
  const result: Observation[] = [];
  for await (const event of buffer.events()) {
    if (event.type === 'action_requested')
      throw new Error('Unexpected manual request');
    result.push(event);
  }
  return result;
}

describe('repair observations', () => {
  it('projects compact patch metadata and copies details independently for each opted-in reader', async () => {
    const buffer = new ObservationBuffer('original-session');
    const compact = buffer.events();
    const full = buffer.events({ includeExecutionDetails: true });
    const anotherFull = buffer.events({ includeExecutionDetails: true });
    const inherited = buffer.events(
      Object.create({ includeExecutionDetails: true }) as ObservationOptions,
    );
    buffer.append({
      type: 'execution_item_completed',
      ...original,
      item: {
        type: 'file_change',
        id: 'patch-1',
        callId: 'patch-1',
        threadId: 'original-session',
        turnId: original.turnId,
        status: 'completed',
        changes: {
          'artifact.txt': { type: 'add', content: 'retained content' },
        },
        stdout: 'private output',
        stderr: null,
      },
    });
    buffer.finish('closed');
    const { value: metadata } = await compact.next();
    expect(metadata).toEqual({
      type: 'execution_item_completed',
      ...original,
      sessionId: 'original-session',
      sequence: 1,
      item: {
        type: 'file_change',
        id: 'patch-1',
        callId: 'patch-1',
        threadId: 'original-session',
        turnId: original.turnId,
        status: 'completed',
      },
    });
    expect((await inherited.next()).value).toEqual(metadata);
    const result = await full.next();
    if (result.done) throw new Error('Expected a retained completion');
    const detailed = result.value;
    if (
      detailed.type !== 'execution_item_completed' ||
      !('changes' in detailed.item)
    )
      throw new Error('Expected patch details');
    expect(detailed.sequence).toBe(1);
    detailed.item.changes['artifact.txt'] = {
      type: 'add',
      content: 'local edit',
    };
    expect((await anotherFull.next()).value).toMatchObject({
      sequence: 1,
      item: {
        changes: {
          'artifact.txt': { type: 'add', content: 'retained content' },
        },
        stdout: 'private output',
      },
    });
  });

  it('signals a gap when a retained execution completion exceeds the live budget', async () => {
    const buffer = new ObservationBuffer('original-session');
    buffer.append({
      type: 'execution_item_completed',
      ...original,
      item: {
        id: 'mcp-1',
        callId: 'mcp-1',
        threadId: 'original-session',
        turnId: original.turnId,
        type: 'mcp_call',
        status: 'completed',
        name: 'lookup',
        serverLabel: 'fixture',
        arguments: {},
        output: { content: 'x'.repeat(70_000) },
        error: null,
      },
    });
    buffer.finish('closed');
    expect((await events(buffer)).map((event) => event.type)).toEqual([
      'gap',
      'session_ended',
    ]);
  });

  it('links future submissions with real identities and parent stream order', async () => {
    const parent = new ObservationBuffer('original-session');
    const child = new ObservationBuffer('repair-session');
    parent.append({ type: 'turn_started', ...original });
    child.append({ type: 'turn_started', ...repair });
    child.linkRepairParent(parent, original.submissionId);
    child.append({
      type: 'subagent_lifecycle',
      subagentId: 'unrelated-child',
      parentAgentId: 'repair-agent',
      status: 'closed',
      kind: 'closed',
    });
    child.append({
      type: 'output_text_delta',
      ...repair,
      itemId: 'repair-message',
      delta: '{"ok":true}',
    });
    child.append({ type: 'turn_finished', ...repair, status: 'completed' });
    child.finish('closed');
    // Closing the correction does not close or terminate the original stream.
    parent.append({ type: 'turn_finished', ...original, status: 'completed' });
    parent.finish('closed');

    expect(await events(parent)).toEqual([
      {
        type: 'turn_started',
        ...original,
        sessionId: 'original-session',
        sequence: 1,
      },
      {
        type: 'output_text_delta',
        ...repair,
        sessionId: 'repair-session',
        parentSubmissionId: original.submissionId,
        itemId: 'repair-message',
        delta: '{"ok":true}',
        sequence: 2,
      },
      {
        type: 'turn_finished',
        ...repair,
        sessionId: 'repair-session',
        parentSubmissionId: original.submissionId,
        status: 'completed',
        sequence: 3,
      },
      {
        type: 'turn_finished',
        ...original,
        sessionId: 'original-session',
        status: 'completed',
        sequence: 4,
      },
      {
        type: 'session_ended',
        sessionId: 'original-session',
        reason: 'closed',
        sequence: 5,
      },
    ]);
    const childEvents = await events(child);
    expect(childEvents.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(childEvents[2]).toMatchObject({
      ...repair,
      sessionId: 'repair-session',
      sequence: 3,
    });
    expect(childEvents.every((event) => !('parentSubmissionId' in event))).toBe(
      true,
    );
    expect(childEvents.at(-1)).toMatchObject({
      type: 'session_ended',
      sessionId: 'repair-session',
    });
  });

  it('detaches linked usage while preserving null and exact large counters', async () => {
    const parent = new ObservationBuffer('original-session');
    const child = new ObservationBuffer('repair-session');
    child.linkRepairParent(parent, original.submissionId);
    const counts = {
      inputTokens: 9_007_199_254_740_993n,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      totalTokens: 9_007_199_254_740_995n,
    };
    const usage = {
      totalTokenUsage: { ...counts },
      lastTokenUsage: { ...counts },
      modelContextWindow: null,
    };
    child.append({ type: 'usage_updated', ...repair, usage });
    child.append({ type: 'usage_updated', ...repair, usage: null });
    usage.totalTokenUsage.inputTokens = 12n;
    usage.lastTokenUsage.totalTokens = 14n;
    child.finish('closed');
    parent.finish('closed');
    const linked = (await events(parent))[0];
    if (linked.type !== 'usage_updated' || linked.usage === null)
      throw new Error('Expected linked usage');
    expect(linked.usage).toEqual({
      totalTokenUsage: counts,
      lastTokenUsage: counts,
      modelContextWindow: null,
    });
    expect(linked.usage).not.toBe(usage);
    expect(Object.isFrozen(linked.usage)).toBe(true);
    expect(Object.isFrozen(linked.usage.totalTokenUsage)).toBe(true);
    expect(Object.isFrozen(linked.usage.lastTokenUsage)).toBe(true);
    expect((await events(parent))[1]).toMatchObject({
      type: 'usage_updated',
      usage: null,
      ...repair,
      parentSubmissionId: original.submissionId,
    });
  });

  it('keeps bounded suffixes and gap cursors local to each stream', async () => {
    const parent = new ObservationBuffer('original-session');
    const child = new ObservationBuffer('repair-session');
    child.append({ type: 'turn_started', ...repair });
    child.linkRepairParent(parent, original.submissionId);
    for (let i = 0; i < 257; i++)
      child.append({
        type: 'output_text_delta',
        ...repair,
        itemId: 'message',
        delta: String(i),
      });
    const parentReader = parent.events();
    const childReader = child.events();
    expect((await parentReader.next()).value).toEqual({
      type: 'gap',
      sessionId: 'original-session',
      firstSequence: 1,
      sequence: 1,
    });
    expect((await childReader.next()).value).toEqual({
      type: 'gap',
      sessionId: 'repair-session',
      firstSequence: 1,
      sequence: 2,
    });
    expect((await parentReader.next()).value).toMatchObject({
      type: 'output_text_delta',
      sequence: 2,
      delta: '1',
    });
    child.append({
      type: 'output_text_delta',
      ...repair,
      itemId: 'oversized',
      delta: 'x'.repeat(65_536),
    });
    child.append({ type: 'turn_finished', ...repair, status: 'failed' });
    expect((await parentReader.next()).value).toEqual({
      type: 'gap',
      sessionId: 'original-session',
      firstSequence: 3,
      sequence: 258,
    });
    expect((await parentReader.next()).value).toMatchObject({
      type: 'turn_finished',
      sessionId: 'repair-session',
      sequence: 259,
      status: 'failed',
    });
    await parentReader.return!();
    await childReader.return!();
  });

  it('leaves ordinary unlinked streams independent', async () => {
    const first = new ObservationBuffer('first');
    const second = new ObservationBuffer('second');
    first.append({ type: 'turn_started', ...original });
    first.finish('closed');
    second.finish('closed');
    expect(await events(first)).toEqual([
      { type: 'turn_started', ...original, sessionId: 'first', sequence: 1 },
      {
        type: 'session_ended',
        sessionId: 'first',
        reason: 'closed',
        sequence: 2,
      },
    ]);
    expect(await events(second)).toEqual([
      {
        type: 'session_ended',
        sessionId: 'second',
        reason: 'closed',
        sequence: 1,
      },
    ]);
  });
});

describe('repair turn projection', () => {
  it('preserves optional parent links through existing exact wire converters', () => {
    const turn: RecordedTurn = {
      id: repair.turnId,
      object: 'agent.session.turn',
      sessionId: 'repair-session',
      subagentId: null,
      status: 'completed',
      createdAt: null,
      startedAt: null,
      completedAt: null,
      error: null,
      usage: {
        inputTokens: 9_007_199_254_740_993n,
        inputTokensDetails: { cachedTokens: 0 },
        outputTokens: 2,
        outputTokensDetails: { reasoningTokens: 0 },
        totalTokens: 9_007_199_254_740_995n,
      },
      parentSessionId: 'original-session',
      parentTurnId: original.turnId,
    };
    const wire = repairTurnWireSchema.parse(recordedTurnToWire(turn));
    expect(wire.usage?.inputTokens).toBe('9007199254740993');
    expect(recordedTurnFromWire(wire)).toEqual(turn);
    const ordinary: RecordedTurn = { ...turn, usage: null };
    delete ordinary.parentSessionId;
    delete ordinary.parentTurnId;
    expect(recordedTurnFromWire(recordedTurnToWire(ordinary))).toEqual(
      ordinary,
    );
  });

  it('redacts executor details and binds repair receipts to their turn', () => {
    const wire = recordedTurnToWire({
      id: repair.turnId,
      object: 'agent.session.turn',
      sessionId: 'repair-session',
      subagentId: null,
      status: 'completed',
      createdAt: null,
      startedAt: null,
      completedAt: null,
      error: null,
      usage: null,
      parentSessionId: 'original-session',
      parentTurnId: original.turnId,
      receipt: {
        threadId: 'repair-session',
        turnId: repair.turnId,
        model: 'gpt-5',
        reasoningEffort: null,
        instructionRevision: null,
        developerInstructionsSha256: 'a'.repeat(64),
        instructionFiles: [],
        userConfigApplied: false,
        codexRevision: 'b'.repeat(40),
        codexSourceTree: 'c'.repeat(40),
        approvalPolicy: 'never',
        executors: [
          {
            environmentId: 'private-executor',
            transport: 'remote',
            cwd: '/private/workspace',
            writableRoots: ['/private/workspace'],
            networkSandbox: 'restricted',
            networkPolicy: null,
          },
        ],
      },
    });
    expect(repairTurnWireSchema.parse(wire).receipt).toMatchObject({
      turnId: repair.turnId,
      executors: null,
    });
    expect(
      repairTurnWireSchema.safeParse({
        ...wire,
        receipt: { ...wire.receipt, threadId: 'unrelated-session' },
      }).success,
    ).toBe(false);
    expect(
      repairTurnWireSchema.safeParse({
        ...wire,
        receipt: { ...wire.receipt, turnId: 'stale-turn' },
      }).success,
    ).toBe(false);
  });
});

describe('repair item projection', () => {
  const sidecar = (item: JsonObject) =>
    repairItemWireSchema.parse({
      parentSessionId: 'original-session',
      parentTurnId: original.turnId,
      sessionId: 'repair-session',
      item,
    });

  it('round-trips every native projected variant, including denied tool calls', () => {
    const webActions: (JsonObject | null)[] = [
      { type: 'search', query: 'format', queries: ['format'] },
      { type: 'open_page', url: null },
      { type: 'find_in_page', url: 'https://example.com', pattern: null },
      { type: 'unknown' },
      null,
    ];
    const native: JsonObject[] = [
      {
        type: 'UserMessage',
        id: 'user',
        content: [
          { type: 'text', text: 'format this' },
          { type: 'image', image_url: 'data:image/png;base64,AQ==' },
        ],
      },
      {
        type: 'AgentMessage',
        id: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'Text', text: '{"ok":true}' }],
      },
      { type: 'Reasoning', id: 'reasoning', summary_text: ['format only'] },
      {
        type: 'DynamicToolCall',
        id: 'forbidden-function',
        tool: 'forbidden',
        arguments: { values: [1, { nested: true }] },
        status: 'failed',
        success: false,
        content_items: [{ type: 'inputText', text: 'Tool is not allowed' }],
      },
      {
        type: 'McpToolCall',
        id: 'forbidden-mcp',
        server: 'server',
        tool: 'forbidden',
        arguments: {},
        status: 'failed',
        error: { message: 'MCP is disabled' },
      },
      {
        type: 'CommandExecution',
        id: 'forbidden-command',
        command: ['echo', 'forbidden'],
        cwd: null,
        status: 'declined',
        aggregated_output: null,
        exit_code: null,
      },
      ...webActions.map((action, index) => ({
        type: 'WebSearch',
        id: `web-${index}`,
        action,
      })),
      ...[
        'spawn_agent',
        'wait',
        'send_input',
        'resume_agent',
        'interrupt_agent',
        'close_agent',
      ].map((tool) => ({
        type: 'CollabAgentToolCall',
        id: tool,
        tool,
        sender_thread_id: 'repair-session',
        receiver_thread_ids: ['child'],
        status: 'failed',
      })),
    ];
    const { items } = projectHistory(
      [
        {
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: repair.turnId },
        },
        ...native.map((item) => ({
          type: 'event_msg',
          payload: { type: 'item_completed', turn_id: repair.turnId, item },
        })),
        {
          type: 'event_msg',
          payload: { type: 'task_complete', turn_id: repair.turnId },
        },
      ],
      'repair-session',
    );
    expect(new Set(items.map((item) => item.type))).toEqual(
      new Set([
        'message',
        'reasoning',
        'function_call',
        'function_call_output',
        'mcp_call',
        'command_execution',
        'web_search_call',
        'create_subagent_call',
        'wait_for_subagents_call',
        'send_subagent_input_call',
        'resume_subagent_call',
        'interrupt_subagent_call',
        'close_subagent_call',
      ]),
    );
    for (const { data: _data, ...item } of items) {
      const wire = sidecar(item);
      expect(repairItemFromWire(wire.item)).toEqual(item);
    }
    expect(items.find((item) => item.type === 'function_call')).toMatchObject({
      status: 'failed',
      name: 'forbidden',
    });
    expect(
      items.find((item) => item.type === 'function_call_output'),
    ).toMatchObject({
      status: 'failed',
      output: null,
      error: 'Tool is not allowed',
    });
  });

  it('preserves supported nullable fields and detaches nested JSON values', () => {
    const wire = sidecar({
      id: 'call',
      turnId: repair.turnId,
      type: 'function_call',
      callId: 'call',
      name: 'forbidden',
      arguments: { nested: ['original'] },
      status: 'in_progress',
    });
    const projected = repairItemFromWire(wire.item);
    if (projected?.type !== 'function_call') throw new Error('Expected call');
    expect(projected.arguments).not.toBe(wire.item.arguments);
    const args = projected.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected object arguments');
    args.nested = ['caller mutation'];
    expect(wire.item.arguments).toEqual({ nested: ['original'] });
    const reasoning = sidecar({
      id: 'reasoning',
      turnId: repair.turnId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'format' }],
      status: null,
    });
    expect(repairItemFromWire(reasoning.item)).toEqual(reasoning.item);
  });

  it('skips incomplete and unknown opaque items without changing recapture data', () => {
    const opaqueItems: JsonObject[] = [
      {
        type: 'message',
        text: 'legacy receipt',
        generation: '9007199254740993',
      },
      { type: 'unknown_item', arbitrary: { nested: ['retained'] } },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: null,
        content: [{ type: 'output_text' }],
      },
      {
        type: 'function_call_output',
        callId: 'call',
        status: 'failed',
        output: null,
      },
    ];
    for (const item of opaqueItems) {
      const wire = sidecar({ id: 'opaque', turnId: repair.turnId, ...item });
      const before = structuredClone(wire);
      expect(repairItemFromWire(wire.item)).toBeNull();
      expect(wire).toEqual(before);
      expect(repairItemWireSchema.parse(wire)).toEqual(before);
    }
  });
});
