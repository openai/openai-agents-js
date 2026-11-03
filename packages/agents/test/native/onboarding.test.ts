import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  type NativeProviderOptions,
} from '@openai/agents';
import { runGreeting } from '../../examples/basic';
import { runToolUpdates } from '../../examples/tool-updates';
import { runTypedContext } from '../../examples/typed-context';
import { ModelServer, call, message } from './fixtures/model-server';
import type { JsonObject } from '../../src/runtime/binding';

const exec = promisify(execFile);
const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});
async function options(server: ModelServer): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-onboarding',
    supportsWebsockets: false,
  };
}

// Native models can declare functions directly or in an additional_tools input item.
function declarations(request: JsonObject) {
  if (Array.isArray(request.tools)) return request.tools;
  const item = (request.input as JsonObject[]).find(
    (item) => item.type === 'additional_tools',
  );
  return (item?.tools as JsonObject[] | undefined)?.find(
    (namespace) => namespace.name === 'functions',
  )?.tools;
}

nativeIt(
  'runs the greeting callback before returning its final answer',
  async () => {
    const server = new ModelServer([
      [call('greeting', { name: 'Ada' }, { callId: 'greeting-call' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('Hello, Ada!');
        return [message('Hello, Ada!')];
      },
    ]);
    expect(await runGreeting(await options(server))).toBe('Hello, Ada!');
    expect(declarations(server.requests[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'greeting',
          parameters: expect.objectContaining({ additionalProperties: false }),
        }),
      ]),
    );
    server.assertExhausted();
  },
);

nativeIt('replaces the example callback between completed turns', async () => {
  const server = new ModelServer([
    [
      call(
        'lookup_price',
        { product: 'notebook' },
        { callId: 'original-lookup' },
      ),
    ],
    (request) => {
      expect(request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'original-lookup',
            output: 'notebook: 5.00 USD',
          }),
        ]),
      );
      return [message('The notebook costs 5.00 USD.')];
    },
    [
      call(
        'lookup_price',
        { product: 'notebook' },
        { callId: 'updated-lookup' },
      ),
    ],
    (request) => {
      expect(request.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call_output',
            call_id: 'updated-lookup',
            output: 'notebook: 4.00 USD',
          }),
        ]),
      );
      return [message('The notebook now costs 4.00 USD.')];
    },
  ]);
  expect(await runToolUpdates(await options(server))).toEqual({
    before: 'The notebook costs 5.00 USD.',
    after: 'The notebook now costs 4.00 USD.',
  });
  expect(server.requests).toHaveLength(4);
  server.assertExhausted();
});

nativeIt(
  'uses current application context outside the tool schema and parses the final object',
  async () => {
    const displayName = 'Ada from the application';
    const server = new ModelServer([
      [call('account_name', {}, { callId: 'account-call' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain(displayName);
        return [
          message(JSON.stringify({ greeting: `Hello, ${displayName}!` })),
        ];
      },
    ]);
    expect(
      await runTypedContext({ displayName }, await options(server)),
    ).toEqual({ greeting: `Hello, ${displayName}!` });
    expect(JSON.stringify(server.requests[0])).not.toContain(displayName);
    expect(declarations(server.requests[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'account_name',
          parameters: expect.objectContaining({
            type: 'object',
            properties: {},
            additionalProperties: false,
          }),
        }),
      ]),
    );
    server.assertExhausted();
  },
);

nativeIt('closes its provider when final output validation fails', async () => {
  const server = new ModelServer([[message('{"greeting":42}')]]);
  const closed = vi.spyOn(NativeProvider.prototype, 'close');
  await expect(
    runTypedContext({ displayName: 'Ada' }, await options(server)),
  ).rejects.toThrow();
  expect(closed).toHaveBeenCalledTimes(1);
  const provider = closed.mock.contexts[0] as NativeProvider;
  await expect(
    new Agent({ instructions: 'Answer.', provider }).session(),
  ).rejects.toThrow('closed');
  server.assertExhausted();
});

nativeIt.each(['basic', 'typed-context'] as const)(
  'runs the %s command-line entrypoint',
  async (name) => {
    const tool = name === 'basic' ? 'greeting' : 'account_name';
    const server = new ModelServer([
      [
        call(tool, name === 'basic' ? { name: 'Ada' } : {}, {
          callId: 'cli-call',
        }),
      ],
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          name === 'basic' ? 'Hello, Ada!' : 'Ada',
        );
        return [
          message(
            name === 'basic' ? 'Hello, Ada!' : '{"greeting":"Hello, Ada!"}',
          ),
        ];
      },
    ]);
    const current = await options(server);
    const result = await exec(
      process.execPath,
      ['--import', 'tsx', resolve('packages/agents/examples/' + name + '.ts')],
      {
        env: {
          ...process.env,
          OPENAI_API_KEY: current.apiKey,
          OPENAI_BASE_URL: current.baseUrl,
        },
        timeout: 20000,
      },
    );
    expect(result.stdout.trim()).toBe('Hello, Ada!');
    server.assertExhausted();
  },
  25000,
);

function suppressedFailure(error: unknown) {
  // TypeScript may supply this error when the native constructor is absent.
  expect(error).toHaveProperty('name', 'SuppressedError');
  expect(error).toHaveProperty('error');
  expect(error).toHaveProperty('suppressed');
  return error as { error: unknown; suppressed: unknown };
}
it.each([
  ['greeting', () => runGreeting()],
  ['typed context', () => runTypedContext({ displayName: 'Ada' })],
] as const)(
  'retains %s run and provider failures',
  async (_name, runExample) => {
    const original = new AggregateError(
      [new Error('Run failed'), new Error('Session cleanup failed')],
      'Run and Session cleanup failed',
    );
    const cleanup = new Error('Provider cleanup failed');
    vi.spyOn(Agent.prototype, 'run').mockRejectedValueOnce(original);
    const closed = vi
      .spyOn(NativeProvider.prototype, 'close')
      .mockRejectedValueOnce(cleanup);
    const error = await runExample().then(
      () => {
        throw new Error('Example unexpectedly succeeded');
      },
      (error: unknown) => error,
    );
    const failure = suppressedFailure(error);
    expect(failure.error).toBe(cleanup);
    expect(failure.suppressed).toBe(original);
    expect(closed).toHaveBeenCalledOnce();
  },
);
