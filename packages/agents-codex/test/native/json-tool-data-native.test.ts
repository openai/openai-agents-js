import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
} from '../../src';
import { parseEvent } from '../../src/runtime/events';
import type { JsonObject, JsonValue } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const serialized =
  '{"key":"kept","__proto__":{"toolDataTop":true},"nested":{"__proto__":{"toolDataNested":true}}}';
const value = () => JSON.parse(serialized) as JsonObject;
const parameters = () =>
  z.object({
    payload: z.unknown().transform((v): JsonValue => v as JsonValue),
  });
const result = () => z.string().transform((v) => JSON.parse(v) as JsonValue);
function preserved(actual: unknown) {
  const data = actual as JsonObject;
  expect(Object.hasOwn(data, '__proto__')).toBe(true);
  expect(Object.hasOwn(data.nested as JsonObject, '__proto__')).toBe(true);
  expect(data).toEqual(value());
  expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(data.nested)).toBe(Object.prototype);
  expect(Object.prototype).not.toHaveProperty('toolDataTop');
  expect(Object.prototype).not.toHaveProperty('toolDataNested');
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-json-data',
    supportsWebsockets: false,
  });
}
function output(request: JsonObject) {
  const item = (request.input as JsonObject[]).find(
    (v) => v.type === 'function_call_output' && v.call_id === 'json-call',
  );
  expect(item).toBeDefined();
  const text =
    typeof item!.output === 'string'
      ? item!.output
      : (item!.output as JsonObject[]).map((p) => p.text ?? '').join('');
  return JSON.parse(text);
}
function server() {
  return new ModelServer([
    [call('lookup', { payload: value() }, { callId: 'json-call' })],
    [message('done')],
  ]);
}
function manual() {
  return manualTool({
    name: 'lookup',
    description: 'Read data.',
    parameters: parameters(),
    result: result(),
  });
}

it('preserves literal JSON keys in automatic arguments, original arguments and transformed results', async () => {
  const model = server();
  await using provider = await providerFor(model);
  const seen: unknown[] = [];
  const declaration = tool({
    name: 'lookup',
    parameters: parameters(),
    result: result(),
    execute(args, context) {
      seen.push(args.payload, context.originalArguments.payload);
      return serialized;
    },
  });
  await using session = await new Agent({
    instructions: 'Read once.',
    model: 'gpt-5',
    provider,
    tools: [declaration],
  }).session();
  expect((await (await session.submit('read')).wait()).finalOutput).toBe(
    'done',
  );
  expect(seen).toHaveLength(2);
  for (const data of seen) preserved(data);
  preserved(output(model.requests[1]));
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
});

it.each([false, true])(
  'preserves manual JSON arguments and transformed replies through restore=%s',
  async (restore) => {
    const model = server();
    await using provider = await providerFor(model);
    const declaration = manual();
    await using original = await new Agent({
      instructions: 'Read once.',
      model: 'gpt-5',
      provider,
      tools: [declaration],
    }).session();
    const turn = await original.submit('read');
    const batch = await turn.wait({ until: 'manual_tool' });
    if (!('requests' in batch)) throw new Error('Expected a manual request');
    const request = declaration.match(batch.requests[0]);
    expect(request).toBeDefined();
    preserved(request!.arguments.payload);
    if (restore) {
      const stale = request!.reply(serialized);
      const checkpoint = parseSessionState(
        JSON.stringify(await original.suspend()),
      );
      await original.close();
      const freshDeclaration = manual();
      await using restored = await new Agent({
        instructions: 'Read once.',
        model: 'gpt-5',
        provider,
        tools: [freshDeclaration],
      }).session({ state: checkpoint });
      const next = await restored.wait({ until: 'manual_tool' });
      if (!('requests' in next))
        throw new Error('Expected a restored manual request');
      const fresh = freshDeclaration.match(next.requests[0]);
      expect(fresh).toBeDefined();
      preserved(fresh!.arguments.payload);
      await expect(restored.respond(stale)).rejects.toThrow();
      expect(model.requests).toHaveLength(1);
      await restored.respond(fresh!.reply(serialized));
      expect((await restored.wait()).finalOutput).toBe('done');
    } else {
      await original.respond(request!.reply(serialized));
      expect((await turn.wait()).finalOutput).toBe('done');
    }
    preserved(output(model.requests[1]));
    expect(model.requests).toHaveLength(2);
    model.assertExhausted();
  },
);

it('keeps managed event envelopes strict while preserving argument JSON', () => {
  const event = {
    id: 'request',
    msg: {
      type: 'dynamic_tool_call_request',
      arguments: value(),
      _sdk_python_tool: { thread: 'root', generation: '1', slot: 0 },
    },
  };
  preserved(parseEvent(JSON.stringify(event)).msg.arguments);
  for (const invalid of [
    { ...event, id: 42 },
    { ...event, msg: { ...event.msg, type: null } },
    {
      ...event,
      msg: {
        ...event.msg,
        _sdk_python_tool: { ...event.msg._sdk_python_tool, slot: -1 },
      },
    },
    {
      ...event,
      msg: {
        ...event.msg,
        _sdk_python_tool: { ...event.msg._sdk_python_tool, generation: '01' },
      },
    },
    {
      ...event,
      msg: {
        ...event.msg,
        _sdk_python_tool: { ...event.msg._sdk_python_tool, thread: 42 },
      },
    },
  ])
    expect(() => parseEvent(JSON.stringify(invalid))).toThrow();
});

it('preserves a terminal JSON result in its public value and saved canonical receipt', async () => {
  const model = new ModelServer([
    [call('finish_json', {}, { callId: 'terminal-json-data' })],
  ]);
  await using provider = await providerFor(model);
  let validations = 0;
  let effects = 0;
  const schema = z.object({ payload: z.unknown() }).transform((v) => {
    validations++;
    return v;
  });
  await using session = await new Agent({
    instructions: 'Finish once.',
    model: 'gpt-5',
    provider,
    outputType: { mode: 'prompted', schema },
    tools: [
      tool({
        name: 'finish_json',
        parameters: z.object({}),
        finishTurn: true,
        execute: () => {
          effects++;
          return JSON.stringify({ payload: value() });
        },
      }),
    ],
  }).session();
  const completed = await (await session.submit('finish')).wait();
  preserved(completed.finalOutput.payload);
  expect(validations).toBe(1);
  const state = await session.saveState();
  const facts = state.history.flatMap((item) => {
    const parsed = z
      .object({
        payload: z.object({
          tool_completion: z.object({
            call_id: z.literal('terminal-json-data'),
            final_output: z.object({ payload: z.unknown() }),
          }),
        }),
      })
      .safeParse(item);
    return parsed.success
      ? [parsed.data.payload.tool_completion.final_output]
      : [];
  });
  expect(facts).toHaveLength(1);
  preserved(facts[0].payload);
  expect(validations).toBe(1);
  await session.close();
  const restoredState = parseSessionState(JSON.stringify(state));
  await using restored = await new Agent({
    instructions: 'Finish once.',
    model: 'gpt-5',
    provider,
    outputType: { mode: 'prompted', schema },
    tools: [
      tool({
        name: 'finish_json',
        parameters: z.object({}),
        finishTurn: true,
        execute: () => {
          effects++;
          return JSON.stringify({ payload: value() });
        },
      }),
    ],
  }).session({ state: restoredState });
  const again = await restored.saveState();
  const canonical = again.history.find((item) => {
    const payload = (item as JsonObject).payload as JsonObject | undefined;
    return (
      payload &&
      typeof payload === 'object' &&
      payload.tool_completion !== undefined
    );
  }) as JsonObject;
  preserved(
    (
      ((canonical.payload as JsonObject).tool_completion as JsonObject)
        .final_output as JsonObject
    ).payload,
  );
  expect(effects).toBe(1);
  expect(validations).toBe(1);
  expect(model.requests).toHaveLength(1);
  model.assertExhausted();
});
