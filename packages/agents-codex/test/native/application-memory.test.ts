import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  type NativeProviderOptions,
  type Turn,
} from '@openai/agents';
import {
  readMemory,
  runMemoryNote,
  type ApplicationMemory,
  type MemoryContext,
} from '../../examples/application-memory';
import { invokeFunctionTool } from '../../src/runtime/tools';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const exec = promisify(execFile);
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

// Exercise the actual managed callback adapter without opening a native Session.
function read(context: MemoryContext, args: JsonObject) {
  return invokeFunctionTool(
    readMemory,
    args,
    {
      context,
      submission: {
        sessionId: 'session',
        childId: 'child',
        instanceId: '1',
        turnId: 'turn',
        submissionId: 'submission',
      },
      threadId: 'session',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    },
    vi.fn(),
  );
}

describe('application memory recipe without native execution', () => {
  it('advertises only the note key', () => {
    const declaration = JSON.parse(JSON.stringify(readMemory));
    expect(declaration.name).toBe('read_memory');
    expect(Object.keys(declaration.parameters.properties)).toEqual(['key']);
    expect(declaration.parameters.required).toEqual(['key']);
    expect(declaration.parameters.additionalProperties).toBe(false);
  });

  it('awaits the application API for the selected key and trusted tenant', async () => {
    const note = Promise.withResolvers<string | undefined>();
    const memory: ApplicationMemory = { readNote: vi.fn(() => note.promise) };
    const running = read({ tenantId: 'tenant-a', memory }, { key: 'audience' });
    let settled = false;
    const observed = running.then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(memory.readNote).toHaveBeenCalledWith('tenant-a', 'audience');
    note.resolve('Explain the result in plain language.');
    await expect(observed).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: 'Explain the result in plain language.',
        },
      ],
    });
  });

  it('keeps the same key isolated between application tenants', async () => {
    const notes = new Map([
      [
        'tenant-a',
        new Map([
          ['audience', 'Plain language.'],
          ['other', 'Not selected.'],
        ]),
      ],
      ['tenant-b', new Map([['audience', 'Engineering details.']])],
    ]);
    const memory: ApplicationMemory = {
      async readNote(tenantId, key) {
        return notes.get(tenantId)?.get(key);
      },
    };
    await expect(
      Promise.all([
        read({ tenantId: 'tenant-a', memory }, { key: 'audience' }),
        read({ tenantId: 'tenant-b', memory }, { key: 'audience' }),
      ]),
    ).resolves.toEqual([
      {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Plain language.' }],
      },
      {
        success: true,
        contentItems: [{ type: 'inputText', text: 'Engineering details.' }],
      },
    ]);
    await expect(
      read({ tenantId: 'tenant-a', memory }, { key: 'tenant-b/audience' }),
    ).resolves.toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: 'No saved note for that key.' },
      ],
    });
  });

  it('rejects a model-supplied tenant before reading memory', async () => {
    const memory: ApplicationMemory = {
      readNote: vi.fn(async () => 'private'),
    };
    await expect(
      read(
        { tenantId: 'tenant-a', memory },
        { key: 'audience', tenantId: 'tenant-b' },
      ),
    ).rejects.toThrow();
    expect(memory.readNote).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'No saved note for that key.'],
    ['', ''],
  ])('distinguishes missing and empty notes: %s', async (note, expected) => {
    const memory: ApplicationMemory = { readNote: async () => note };
    await expect(
      read({ tenantId: 'tenant-a', memory }, { key: 'audience' }),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: expected }],
    });
  });

  it('propagates API failures rather than reporting a missing note', async () => {
    const failure = new Error('Application memory unavailable');
    const memory: ApplicationMemory = {
      readNote: async () => {
        throw failure;
      },
    };
    await expect(
      read({ tenantId: 'tenant-a', memory }, { key: 'audience' }),
    ).rejects.toBe(failure);
  });

  it('passes context through Agent.run while keeping the tenant out of the prompt', async () => {
    const context: MemoryContext = {
      tenantId: 'authenticated-tenant',
      memory: { readNote: async () => 'plain language' },
    };
    const run = vi.spyOn(Agent.prototype, 'run').mockResolvedValueOnce({
      turn: {} as Turn,
      usage: null,
      finalOutput: 'Use plain language.',
      repairAttempts: [],
    });
    const close = vi.spyOn(NativeProvider.prototype, 'close');
    await expect(runMemoryNote(context, 'audience')).resolves.toBe(
      'Use plain language.',
    );
    expect(run).toHaveBeenCalledWith(
      'Read the saved note with key "audience".',
      { context },
    );
    const agent = run.mock.contexts[0] as Agent<MemoryContext>;
    expect(agent.tools).toEqual([readMemory]);
    expect(agent.instructions).not.toContain(context.tenantId);
    expect(run.mock.calls[0][0]).not.toContain(context.tenantId);
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains the run error when provider disposal also fails', async () => {
    const original = new Error('Memory run failed');
    const cleanup = new Error('Provider cleanup failed');
    vi.spyOn(Agent.prototype, 'run').mockRejectedValueOnce(original);
    vi.spyOn(NativeProvider.prototype, 'close').mockRejectedValueOnce(cleanup);
    const context: MemoryContext = {
      tenantId: 'tenant-a',
      memory: { readNote: async () => undefined },
    };
    const failure = await runMemoryNote(context, 'audience').then(
      () => {
        throw new Error('Expected the run to fail');
      },
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      name: 'SuppressedError',
      error: cleanup,
      suppressed: original,
    });
  });
});

async function providerOptions(
  server: ModelServer,
): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-application-memory',
    supportsWebsockets: false,
  };
}

// Core can declare functions directly or in its additional_tools input item.
function declarations(request: JsonObject) {
  if (Array.isArray(request.tools)) return request.tools;
  const item = (request.input as JsonObject[]).find(
    (item) => item.type === 'additional_tools',
  );
  return (item?.tools as JsonObject[] | undefined)?.find(
    (namespace) => namespace.name === 'functions',
  )?.tools;
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'application memory recipe with the native runtime',
  () => {
    it('runs the public CLI with only the selected tenant note in model requests', async () => {
      const note = 'Explain the result in plain language.';
      const otherNote = 'Use technical terms for the engineering team.';
      const answer = `Audience note: ${note}`;
      const server = new ModelServer([
        [call('read_memory', { key: 'audience' }, { callId: 'memory-note' })],
        (request) => {
          expect(JSON.stringify(request.input)).toContain(note);
          expect(JSON.stringify(request.input)).not.toContain(otherNote);
          return [message(answer)];
        },
      ]);
      const options = await providerOptions(server);
      const result = await exec(
        process.execPath,
        [
          '--import',
          'tsx',
          resolve('packages/agents-codex/examples/application-memory.ts'),
        ],
        {
          env: {
            ...process.env,
            OPENAI_API_KEY: options.apiKey,
            OPENAI_BASE_URL: options.baseUrl,
          },
          timeout: 20000,
        },
      );
      expect(result.stdout.trim()).toBe(answer);
      expect(server.requests).toHaveLength(2);
      expect(JSON.stringify(server.requests[0].input)).toContain('audience');
      const memory = (declarations(server.requests[0]) as JsonObject[]).find(
        (tool) => tool.name === 'read_memory',
      );
      expect(memory).toBeDefined();
      const parameters = memory!.parameters as JsonObject;
      expect(Object.keys(parameters.properties as JsonObject)).toEqual(['key']);
      expect(parameters.required).toEqual(['key']);
      expect(parameters.additionalProperties).toBe(false);
      const requests = JSON.stringify(server.requests);
      for (const privateValue of [
        'tenant-a',
        'tenant-b',
        'tenantId',
        'readNote',
        otherNote,
        options.apiKey!,
      ]) {
        expect(requests).not.toContain(privateValue);
      }
      server.assertExhausted();
    }, 25000);

    it('retains an actual application API failure after owned cleanup without another request', async () => {
      const server = new ModelServer([
        [
          call(
            'read_memory',
            { key: 'audience' },
            { callId: 'failed-memory-note' },
          ),
        ],
      ]);
      const failure = new Error('Application memory API failed');
      const readNote = vi.fn(async () => {
        throw failure;
      });
      const context: MemoryContext = {
        tenantId: 'private-tenant',
        memory: { readNote },
      };
      await expect(
        runMemoryNote(context, 'audience', await providerOptions(server)),
      ).rejects.toBe(failure);
      expect(readNote).toHaveBeenCalledWith('private-tenant', 'audience');
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    }, 25000);
  },
);
