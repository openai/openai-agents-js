import { expect, it } from 'vitest';
import { z } from 'zod';
import { Environment } from '../src/runtime/environment';
import { applyExecutorPolicy } from '../src/runtime/executor-policy';
import { selectMcpTools } from '../src/runtime/selected-mcp';
import {
  captureTools,
  invokeFunctionTool,
  type ToolCallContext,
} from '../src/runtime/tools';
import { manualTool, createManualRequest } from '../src/runtime/manual';
import {
  replaceExecutorArguments,
  readExecutorPolicyDecision,
} from '../src/runtime/executor-decisions';
import {
  encodeOperationSelection,
  encodeReceipt,
  type JsonObject,
} from '../src/runtime/binding';
import {
  threadHistorySchema,
  repairItemWireSchema,
} from '../src/runtime/history';
import { CODEX_REVISION, parseSessionState } from '../src/runtime/state';
import { httpError, toolCall, withScriptedResponses } from '../src/testing';
import { BorrowedPeer } from './native/fixtures/borrowed-mcp';

// JSON text creates own data properties without invoking Object.prototype setters.
const data = () =>
  JSON.parse(
    '{"__proto__":{"retained":"data"},"constructor":"ctor","prototype":"proto","ordinary":"value"}',
  );
const schema = () =>
  JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"prototype":{"type":"string"},"ordinary":{"type":"string"}},"required":["__proto__","constructor","prototype","ordinary"],"additionalProperties":false}',
  );
function expectData(value: object) {
  expect(value).toEqual(data());
  expect(Object.hasOwn(value, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
}

it('retains borrowed MCP required properties through catalog and operation encoding', async () => {
  const peer = new BorrowedPeer();
  peer.declarations[0].inputSchema = schema();
  const selected = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  const catalog = captureTools(selected);
  const captured = JSON.parse(catalog.specsJson)[0].tools[0].inputSchema;
  expect(captured).toEqual(schema());
  for (const name of captured.required)
    expect(Object.hasOwn(captured.properties, name)).toBe(true);
  const operation = JSON.parse(
    encodeOperationSelection({
      managed_tool_specs: JSON.parse(catalog.specsJson),
    }),
  );
  expect(operation.managed_tool_specs[0].tools[0].inputSchema).toEqual(
    schema(),
  );
  expect(
    Object.hasOwn(
      operation.managed_tool_specs[0].tools[0].inputSchema.properties,
      '__proto__',
    ),
  ).toBe(true);
});

it('delivers borrowed MCP structured JSON and arguments without losing own keys', async () => {
  const peer = Object.assign(new BorrowedPeer(), {
    useStructuredContent: true,
    async callToolResult(_name: string, args: unknown) {
      expectData(args as object);
      return { content: [], structuredContent: data() };
    },
  });
  const [selected] = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  const context = {
    context: undefined,
    submission: {},
    threadId: 'root',
    turnId: 'turn',
    callId: 'call',
    signal: new AbortController().signal,
  } as ToolCallContext;
  const output = await invokeFunctionTool(selected, data(), context, () => {});
  const part = output.contentItems[0];
  expect(part.type).toBe('inputText');
  expectData(JSON.parse((part as { text: string }).text));
});

it('keeps fixture arguments, error bodies, and captured HTTP requests intact', async () => {
  const call = toolCall('lookup', data(), { callId: 'own-keys' });
  if (call.type !== 'function_call') throw new Error('Expected function call');
  expectData(JSON.parse(call.arguments));
  const failure = httpError(400, { error: data() });
  await withScriptedResponses([failure], async (peer) => {
    const response = await fetch(`${peer.provider.baseUrl}/responses`, {
      method: 'POST',
      body: JSON.stringify({ input: data() }),
    });
    expect(response.status).toBe(400);
    expectData((await response.json()).error);
    expectData(peer.requests[0].input as object);
  });
});

it('copies executor replacements while preserving own JSON keys', () => {
  const original = data();
  const decision = replaceExecutorArguments(original);
  original.ordinary = 'changed';
  const captured = readExecutorPolicyDecision(decision);
  expect(captured?.kind).toBe('replace');
  if (captured?.kind === 'replace') expectData(captured.value as object);
});

it('preserves history tool data, repair payloads, and checkpoint declarations', () => {
  const history = threadHistorySchema.parse([
    {
      type: 'response_item',
      payload: { type: 'function_call', arguments: data() },
    },
  ]);
  expectData(history[0].payload.arguments as object);
  const repair = repairItemWireSchema.parse({
    parentSessionId: 'parent',
    parentTurnId: 'parent-turn',
    sessionId: 'root',
    item: { id: 'item', turnId: 'turn', type: 'mcp_call', output: data() },
  });
  expectData(repair.item.output as object);
  const source = {
    format_version: 2,
    codex_revision: CODEX_REVISION,
    source_session_id: 'root',
    root_metadata: {},
    history,
    managed_tool_specs: [
      { type: 'function', name: 'lookup', inputSchema: schema() },
    ],
    pending_actions: [{ arguments: data() }],
  };
  const saved = parseSessionState(encodeReceipt(source));
  expectData((saved.history[0].payload as JsonObject).arguments as object);
  expect((saved.managed_tool_specs as JsonObject[])[0].inputSchema).toEqual(
    schema(),
  );
  expectData(saved.pending_actions[0].arguments as object);
});

it('keeps user manual result validation active while retaining nested JSON', () => {
  const declaration = manualTool({
    name: 'lookup',
    description: '',
    parameters: z.object({ query: z.string() }),
    result: z.object({ value: z.unknown(), approved: z.literal(true) }),
  });
  const owner = createManualRequest(
    declaration,
    {
      sessionId: 'root',
      submissionId: 'submission',
      subagentId: null,
      turnId: 'turn',
      callId: 'call',
    },
    { query: 'lookup' },
    () => true,
  );
  const request = owner.request()!;
  expect(() =>
    owner.takeReply(request.reply({ value: data(), approved: false } as never)),
  ).toThrow('Manual tool result failed validation');
  const result = owner.takeReply(
    request.reply({ value: data(), approved: true }),
  )!;
  const part = result.contentItems[0] as { text: string };
  expectData(JSON.parse(part.text).value);
});

it.each([false, true])(
  'retains executor JSON arguments and replacements (decision=%s)',
  async (explicit) => {
    const environment = new Environment({
      url: 'wss://example.invalid',
      cwd: '/workspace',
      tools: ['exec_command'],
      transformArguments: (_context, args) => {
        expectData(args as object);
        return explicit ? replaceExecutorArguments(data()) : data();
      },
    });
    const result = await applyExecutorPolicy(
      environment,
      null as never,
      null as never,
      undefined,
      { sessionId: 'root' } as never,
      {
        tool_name: { namespace: 'functions', name: 'exec_command' },
        phase: 'before',
        tool_kind: 'function_json',
        input: JSON.stringify(data()),
        thread_id: 'root',
        turn_id: 'turn',
      },
      new AbortController().signal,
      () => {},
    );
    expect(result.action).toBe('replace');
    expectData(result.value as object);
  },
);
