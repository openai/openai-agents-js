import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeBinding from '../src/runtime/binding';
import * as turnReceipt from '../src/runtime/turn-receipt';
import {
  Agent,
  NativeProvider,
  tool,
  HttpMCP,
  checklist,
  webSearch,
  fileSearch,
} from '../src';
import { z } from 'zod';
import {
  capturePreparedRequest,
  preparedRequestFromNative,
  type PreparedRequestData,
} from '../src/runtime/prepared-request';

afterEach(() => vi.restoreAllMocks());

const native = () => ({
  instructions: 'original',
  input: [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    },
  ],
  tools: [
    {
      namespace: null,
      name: 'reserve',
      kind: 'function',
      strict: true,
      defer_loading: null,
      description: 'reserve allowed',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', enum: ['allowed'] } },
      },
    },
  ],
});

describe('prepared request capture boundary', () => {
  it('preserves own JSON keys in replacement tool schemas', () => {
    const request = preparedRequestFromNative(native());
    const parameters = JSON.parse(
      '{"type":"object","__proto__":{"annotation":"data"},"properties":{}}',
    );
    request.tools[0].parameters = parameters;
    const captured = JSON.parse(capturePreparedRequest(request));
    expect(captured.tools[0].parameters).toEqual(parameters);
    expect(Object.hasOwn(captured.tools[0].parameters, '__proto__')).toBe(true);
  });

  it('detaches native input and preserves public camelCase evidence through strict capture', () => {
    const source = native();
    const request = preparedRequestFromNative(source);
    request.instructions = 'sampling only';
    (request.input[0] as { role: string }).role = 'system';
    request.tools[0].description = 'changed';
    expect(source).toEqual(native());
    const captured = capturePreparedRequest(request);
    request.instructions = 'retained mutation';
    expect(JSON.parse(captured)).toMatchObject({
      instructions: 'sampling only',
      tools: [{ defer_loading: null, description: 'changed' }],
    });
    expect(captured).not.toContain('deferLoading');
  });
  it.each(['extra', 'defer_loading'])(
    'rejects unknown public fields even when undefined: %s',
    (key) => {
      const request = preparedRequestFromNative(native());
      Object.assign(request, { [key]: undefined });
      expect(() => capturePreparedRequest(request)).toThrow(
        'Unknown prepared request field',
      );
      const tool = preparedRequestFromNative(native());
      Object.assign(tool.tools[0], { [key]: undefined });
      expect(() => capturePreparedRequest(tool)).toThrow(
        'Unknown prepared request field',
      );
    },
  );
  it.each([undefined, NaN, Infinity, new Date(), { toJSON: () => ({}) }])(
    'rejects lossy nested JSON: %s',
    (invalid) => {
      const request = preparedRequestFromNative(native());
      request.input.push({ unknown: invalid } as never);
      expect(() => capturePreparedRequest(request)).toThrow();
    },
  );
  it('rejects omitted fields, cycles, sparse arrays, and non-object schemas', () => {
    const request = preparedRequestFromNative(native());
    delete (request as Partial<PreparedRequestData>).instructions;
    expect(() => capturePreparedRequest(request)).toThrow();
    const cyclic = preparedRequestFromNative(native());
    cyclic.input.push(cyclic as never);
    expect(() => capturePreparedRequest(cyclic)).toThrow();
    const sparse = preparedRequestFromNative(native());
    sparse.input = new Array(2);
    expect(() => capturePreparedRequest(sparse)).toThrow();
    const schema = preparedRequestFromNative(native());
    schema.tools[0].parameters = [] as never;
    expect(() => capturePreparedRequest(schema)).toThrow();
  });
});

it.each([
  'websocket',
  'deferred-function',
  'deferred-mcp',
  'checklist',
  'hosted-web-search',
  'hosted-file-search',
] as const)(
  'rejects unsupported %s before provider acquisition or editor invocation',
  async (profile) => {
    const provider = new NativeProvider(
      profile === 'websocket' ? {} : { supportsWebsockets: false },
    );
    const acquire = vi.spyOn(provider, '_acquire');
    const loader = vi
      .spyOn(nativeBinding, 'binding')
      .mockRejectedValue(new Error('unexpected native loading'));
    const editor = vi.fn(() => undefined);
    const tools =
      profile === 'deferred-function'
        ? [
            tool({
              name: 'lookup',
              deferLoading: true,
              parameters: z.object({}),
              execute: () => 'unreachable',
            }),
          ]
        : profile === 'deferred-mcp'
          ? [
              new HttpMCP({
                name: 'remote',
                tools: ['lookup'],
                deferLoading: true,
                url: 'http://127.0.0.1:1/mcp',
              }),
            ]
          : profile === 'checklist'
            ? [checklist()]
            : profile === 'hosted-web-search'
              ? [webSearch({ route: 'hosted' })]
              : profile === 'hosted-file-search'
                ? [fileSearch('vs_fixture')]
                : [];
    await expect(
      new Agent({ instructions: 'Answer.', provider, tools }).run('go', {
        prepareRequest: editor,
      }),
    ).rejects.toThrow(
      profile === 'websocket' ? 'supportsWebsockets: false' : 'eager function',
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
    await provider.close();
  },
);

it.each([
  { responseMode: 'buffered' as const },
  { responseMode: 'buffered' as const, supportsWebsockets: false },
  { baseUrl: 'http://127.0.0.1:1/v1' },
])(
  'admits prepared requests for the effective HTTP transport: %j',
  async (options) => {
    await using provider = new NativeProvider(options);
    const boundary = new Error(
      'instruction loading follows transport preflight',
    );
    const loadFiles = vi
      .spyOn(turnReceipt, 'loadInstructionFiles')
      .mockRejectedValueOnce(boundary);
    const acquire = vi.spyOn(provider, '_acquire');
    const prepareRequest = vi.fn(() => undefined);
    await expect(
      new Agent({ instructions: 'Answer.', provider }).run('go', {
        prepareRequest,
        instructionFiles: ['unreachable-instructions.md'],
      }),
    ).rejects.toBe(boundary);
    expect(loadFiles).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
    expect(prepareRequest).not.toHaveBeenCalled();
  },
);

it.each(['default', 'override'] as const)(
  'rejects resolved %s output correction before provider acquisition',
  async (source) => {
    const provider = new NativeProvider({ supportsWebsockets: false });
    const acquire = vi.spyOn(provider, '_acquire');
    const loadFiles = vi
      .spyOn(turnReceipt, 'loadInstructionFiles')
      .mockRejectedValue(
        new Error('instruction loading must follow editor preflight'),
      );
    const prepareRequest = vi.fn(() => undefined);
    const outputType = {
      mode: 'prompted' as const,
      schema: z.object({ answer: z.string() }),
      maxRetries: 1,
    };
    const agent = new Agent<undefined, string | { answer: string }>({
      instructions: 'Answer.',
      provider,
      ...(source === 'default' ? { outputType } : {}),
    });
    const view =
      source === 'default' ? agent : agent.withOutputType(outputType);
    await expect(
      view.run('go', {
        prepareRequest,
        instructionFiles: ['unreachable-instructions.md'],
      }),
    ).rejects.toThrow('output correction attempts');
    expect(loadFiles).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(prepareRequest).not.toHaveBeenCalled();
    await provider.close();
  },
);

it.each(['native', 'prompted-zero', 'omitted-editor'] as const)(
  'retains public admission for %s output',
  async (profile) => {
    const provider = new NativeProvider({ supportsWebsockets: false });
    const boundary = new Error('native loader boundary');
    const loader = vi
      .spyOn(nativeBinding, 'binding')
      .mockRejectedValueOnce(boundary);
    const acquire = vi.spyOn(provider, '_acquire');
    const outputType =
      profile === 'native'
        ? { mode: 'native' as const, schema: z.object({ answer: z.string() }) }
        : {
            mode: 'prompted' as const,
            schema: z.object({ answer: z.string() }),
            maxRetries: profile === 'prompted-zero' ? 0 : 1,
          };
    const agent = new Agent({ instructions: 'Answer.', provider, outputType });
    await expect(
      agent.run(
        'go',
        profile === 'omitted-editor' ? {} : { prepareRequest: () => undefined },
      ),
    ).rejects.toBe(boundary);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(acquire).not.toHaveBeenCalled();
    await provider.close();
  },
);
