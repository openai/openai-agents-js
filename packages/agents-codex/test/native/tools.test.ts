import {
  Environment,
  environmentConfig,
  projectSearchRuntime,
} from '../../src/runtime/environment';
import {
  executorPolicyRules,
  applyExecutorPolicy,
} from '../../src/runtime/executor-policy';
import type { Session } from '../../src/runtime/session';
import { Agent } from '../../src/runtime/public-agent';
import { toolRef } from '../../src/runtime/tools';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import type {
  ActionRequested,
  ExecutorContext,
  NativeToolCall,
  ToolContext,
} from '@openai/agents';
import {
  managedCallInfo,
  interceptedCallInfo,
} from '../../src/runtime/call-metadata';
import {
  captureTools,
  tool,
  outputOf,
  invokeFunctionTool,
  ToolOutput,
  ToolTimeoutError,
} from '../../src/runtime/tools';

const context = {
  context: undefined,
  submission: {
    sessionId: 'root',
    childId: 'child',
    instanceId: '1',
    turnId: 't',
    submissionId: 's',
  },
  threadId: 'root',
  turnId: 't',
  callId: 'c',
  signal: new AbortController().signal,
};

describe('project search declarations', () => {
  it('derives private native configuration from the trusted normalized opening root', () => {
    const selected = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/project with spaces',
      tools: ['exec_command', 'project_grep'],
      writableRoots: ['/output'],
      capabilityDirectories: ['/skills'],
    });
    expect(projectSearchRuntime(selected)).toEqual({
      _sdk_project_search: {
        root: 'file:///project%20with%20spaces',
        tools: ['project_grep'],
      },
    });
    const captured = projectSearchRuntime(selected);
    captured._sdk_project_search!.tools.length = 0;
    expect(projectSearchRuntime(selected)._sdk_project_search?.tools).toEqual([
      'project_grep',
    ]);
    expect(projectSearchRuntime(undefined)).toEqual({});
    expect(
      projectSearchRuntime(
        new Environment({
          url: 'wss://executor.invalid',
          cwd: '/project',
          tools: ['exec_command'],
        }),
      ),
    ).toEqual({});
  });
  it.each(['local', 'remote'] as const)(
    'admits search without command tools on a %s Environment',
    (kind) => {
      const options = {
        cwd: '/workspace',
        tools: ['project_glob', 'project_grep'] as const,
      };
      const environment =
        kind === 'local'
          ? Environment.local(options)
          : new Environment({ ...options, url: 'wss://executor.invalid' });
      expect(environment.tools).toEqual(['project_glob', 'project_grep']);
      expect(Object.isFrozen(environment.tools)).toBe(true);
    },
  );

  it('leaves search disabled by default and rejects duplicate or unknown names', () => {
    const connection = { cwd: '/workspace', url: 'wss://executor.invalid' };
    expect(new Environment(connection).tools).toEqual([]);
    expect(
      () =>
        new Environment({
          ...connection,
          tools: ['project_glob', 'project_glob'],
        }),
    ).toThrow('Select distinct executor tool names');
    expect(
      () =>
        new Environment({ ...connection, tools: ['project_search' as never] }),
    ).toThrow('Select distinct executor tool names');
  });
});

it('preserves old structural context and request shapes', () => {
  expectTypeOf<
    typeof context & {
      originalArguments: Readonly<Record<string, never>>;
      effectiveArguments: Readonly<Record<string, never>>;
    }
  >().toExtend<ToolContext>();
  expectTypeOf<Omit<ActionRequested, 'call'>>().toExtend<ActionRequested>();
  expectTypeOf<Omit<ExecutorContext, 'call'>>().toExtend<ExecutorContext>();
  expectTypeOf<
    Omit<NativeToolCall, 'agentRole' | 'model'>
  >().toExtend<NativeToolCall>();
});

it('requires explicit managed source and preserves unavailable native attribution as null', () => {
  const owner = { sessionId: 'root', childId: null, childIncarnation: null };
  const msg = { tool: 'lookup', turnId: 't', callId: 'synthetic' };
  expect(() => managedCallInfo(owner, msg)).toThrow();
  const call = managedCallInfo(owner, { ...msg, _sdk_code_origin: null });
  expect(call.model).toBeNull();
  expect(Object.isFrozen(call)).toBe(true);
  expect(Object.isFrozen(call.tool)).toBe(true);
  const nested = interceptedCallInfo(context.submission, {
    tool_name: { name: 'exec_command', namespace: 'functions' },
    turn_id: 't',
    route: 'code_mode',
    call_id: null,
    outer_call_id: 'outer',
    cell_id: 'cell',
    runtime_tool_call_id: 'nested',
    incarnation: 'native-incarnation',
  });
  expect(nested).toMatchObject({
    callId: null,
    outerCallId: 'outer',
    cellId: 'cell',
    nestedCallId: 'nested',
    role: null,
    model: null,
    childId: 'child',
    childIncarnation: 'native-incarnation',
    route: 'code',
  });
});

describe('function tools', () => {
  it('rejects callback deadlines beyond the timer range before executing work', () => {
    const execute = vi.fn(() => 'done');
    const options = { name: 'bounded', parameters: z.object({}), execute };
    expect(() =>
      tool({ ...options, callbackTimeout: 2_147_483.647 }),
    ).not.toThrow();
    for (const callbackTimeout of [
      2_147_483.648,
      30 * 24 * 60 * 60,
      Infinity,
      NaN,
      0,
    ]) {
      expect(() => tool({ ...options, callbackTimeout })).toThrow(
        'callbackTimeout',
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns an inline image through the function tool output pipeline', async () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U=';
    const definedTool = tool({
      name: 'image',
      parameters: z.object({}),
      execute: () => ToolOutput.image(imageUrl),
    });

    await expect(
      invokeFunctionTool(definedTool, {}, context, vi.fn()),
    ).resolves.toEqual({
      contentItems: [{ type: 'inputImage', imageUrl }],
      success: true,
    });
  });

  it.each([
    'file-id',
    '/tmp/image.png',
    'data:text/plain;base64,aW1hZ2U=',
    'data:image/png,aW1hZ2U=',
    'data:image/png;base64,',
    'data:image/png;base64',
    'data:image/png,ignored;base64,aW1hZ2U=',
    null,
  ])('rejects an unsupported image factory input: %s', (imageUrl) => {
    expect(() => ToolOutput.image(imageUrl as string)).toThrow(TypeError);
  });

  it('preserves the general image constructor without applying factory restrictions', () => {
    const imageUrl = 'https://example.invalid/image.png';
    expect(
      outputOf(new ToolOutput([{ type: 'inputImage', imageUrl }])),
    ).toEqual({
      contentItems: [{ type: 'inputImage', imageUrl }],
      success: true,
    });
  });

  it('rejects a nonboolean discovery option before capturing native authority', () => {
    expect(() =>
      tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => 'unused',
        // JavaScript applications can supply an invalid discovery declaration.
        // @ts-expect-error Discovery grants require an actual boolean.
        deferLoading: 'false',
      }),
    ).toThrow('deferLoading must be a boolean');
  });
  it('does not enter a callback after validation cancels the call', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during validation');
    const execute = vi.fn(() => 'unused');
    const definedTool = tool({
      name: 'cancelled',
      parameters: z.object({}).refine(() => {
        controller.abort(reason);
        return true;
      }),
      execute,
    });
    await expect(
      invokeFunctionTool(
        definedTool,
        {},
        { ...context, signal: controller.signal },
        vi.fn(),
      ),
    ).rejects.toBe(reason);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses captured validation and invocation until an explicit replacement', async () => {
    const options = {
      name: 'lookup',
      parameters: z.object({ key: z.string().min(1) }),
      execute: ({ key }: { key: string }) => ({ found: key }),
    };
    const catalog = captureTools([tool(options)]);
    options.parameters = z.object({ key: z.string().max(0) });
    options.execute = () => ({ found: 'replacement' });
    const [captured] = catalog.tools;
    const result = await invokeFunctionTool(
      captured,
      { key: 'abc' },
      context,
      vi.fn(),
    );
    expect(result.contentItems).toEqual([
      { type: 'inputText', text: '{"found":"abc"}' },
    ]);
    await expect(
      invokeFunctionTool(captured, { key: '' }, context, vi.fn()),
    ).rejects.toThrow();
  });

  it('refuses duplicate bindings before any catalog can become live', () => {
    const definedTool = tool({
      name: 'same',
      parameters: z.object({}),
      execute: () => 'done',
    });
    expect(() => captureTools([definedTool, definedTool])).toThrow(TypeError);
  });

  it('distinguishes explicit native content from ordinary JSON results', () => {
    const contentItems: ToolOutput['contentItems'] = [
      {
        type: 'inputAudio' as const,
        audioUrl: 'data:audio/wav;base64,UklGRg==',
      },
      {
        type: 'inputImage' as const,
        imageUrl: 'data:image/png;base64,aW1hZ2U=',
      },
    ];
    const native = new ToolOutput(contentItems);
    expect(outputOf(native)).toEqual({ contentItems, success: true });
    expect(JSON.parse(JSON.stringify(native))).toEqual({
      contentItems,
      success: true,
    });
    const business = { contentItems, success: false };
    expect(outputOf(business)).toEqual(
      new ToolOutput([{ type: 'inputText', text: JSON.stringify(business) }]),
    );
  });
});

describe('function tool policies', () => {
  it('revalidates replacements and runs result conversion before the after hook', async () => {
    const stages: string[] = [];
    const defined = tool({
      name: 'policy',
      parameters: z.object({
        key: z.string().trim(),
        limit: z.number().default(2),
      }),
      before(info) {
        stages.push('before');
        expect(info.originalArguments).toEqual({ key: ' original ' });
        expect(info.effectiveArguments).toEqual({ key: 'original', limit: 2 });
        return {
          action: 'replaceArguments',
          arguments: { key: ' replacement ' },
        };
      },
      execute(args, info) {
        stages.push('execute');
        expect(args).toEqual({ key: 'replacement', limit: 2 });
        expect(info.originalArguments).toEqual({ key: ' original ' });
        expect(info.effectiveArguments).toEqual(args);
        return args.key;
      },
      result: z.string().transform((value) => {
        stages.push('result');
        return { found: value };
      }),
      after(output, info) {
        stages.push('after');
        expect(info.effectiveArguments).toEqual({
          key: 'replacement',
          limit: 2,
        });
        expect(output).toBeInstanceOf(ToolOutput);
        expect(output.contentItems).toEqual([
          { type: 'inputText', text: '{"found":"replacement"}' },
        ]);
        return new ToolOutput([{ type: 'inputText', text: 'filtered' }]);
      },
    });
    await expect(
      invokeFunctionTool(defined, { key: ' original ' }, context, vi.fn()),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'filtered' }],
    });
    expect(stages).toEqual(['before', 'execute', 'result', 'after']);
  });

  it('denies locally without executing, validating a result, or invoking after', async () => {
    const execute = vi.fn(() => 'unused');
    const validateResult = vi.fn(() => true);
    const after = vi.fn((output: ToolOutput) => output);
    const defined = tool({
      name: 'denied',
      parameters: z.object({}),
      before: () => ({ action: 'deny', reason: 'Unavailable' }),
      result: z.string().refine(validateResult),
      execute,
      after,
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Unavailable' }],
    });
    expect(execute).not.toHaveBeenCalled();
    expect(validateResult).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('rejects invalid replacement arguments before executing', async () => {
    const execute = vi.fn(() => 'unused');
    const defined = tool({
      name: 'replacement',
      parameters: z.object({ value: z.number().positive() }),
      before: () => ({ action: 'replaceArguments', arguments: { value: -1 } }),
      execute,
    });
    await expect(
      invokeFunctionTool(defined, { value: 1 }, context, vi.fn()),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('detaches original arguments and exposes a frozen effective argument view', async () => {
    const raw = { record: { value: 'original' } };
    const defined = tool({
      name: 'detached',
      parameters: z.object({ record: z.object({ value: z.string() }) }),
      before(info) {
        (info.originalArguments.record as { value: string }).value =
          'changed snapshot';
        expect(Object.isFrozen(info.effectiveArguments)).toBe(true);
        return { action: 'allow' };
      },
      execute(args) {
        expect(args.record.value).toBe('original');
        args.record.value = 'changed execution';
        return 'done';
      },
    });
    await invokeFunctionTool(defined, raw, context, vi.fn());
    expect(raw).toEqual({ record: { value: 'original' } });
  });

  it.each(['signal', 'native'] as const)(
    'checks %s revocation after an awaited before policy',
    async (boundary) => {
      const controller = new AbortController();
      const reason = new Error('revoked');
      let admitted = true;
      const execute = vi.fn(() => 'unused');
      const after = vi.fn((output: ToolOutput) => output);
      const defined = tool({
        name: 'revoked',
        parameters: z.object({}),
        execute,
        after,
        async before() {
          await Promise.resolve();
          if (boundary === 'signal') controller.abort(reason);
          else admitted = false;
          return { action: 'allow' };
        },
      });
      await expect(
        invokeFunctionTool(
          defined,
          {},
          { ...context, signal: controller.signal },
          vi.fn(),
          () => {
            if (!admitted) throw reason;
          },
        ),
      ).rejects.toBe(reason);
      expect(execute).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    },
  );

  it('does not run after when result validation revokes native admission', async () => {
    const reason = new Error('revoked by result validation');
    let admitted = true;
    const after = vi.fn((output: ToolOutput) => output);
    const defined = tool({
      name: 'revoked_result',
      parameters: z.object({}),
      execute: () => 'done',
      after,
      result: z.string().refine(() => {
        admitted = false;
        return true;
      }),
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn(), () => {
        if (!admitted) throw reason;
      }),
    ).rejects.toBe(reason);
    expect(after).not.toHaveBeenCalled();
  });

  it('checks the final envelope after the after hook', async () => {
    const defined = tool({
      name: 'malformed',
      parameters: z.object({}),
      execute: () => 'valid',
      after: () =>
        new ToolOutput([{ type: 'inputText', text: 42 as unknown as string }]),
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).rejects.toThrow();
  });

  it('captures policy and result options when the tool is defined', async () => {
    const options = {
      name: 'captured',
      parameters: z.object({}),
      before: () => ({ action: 'allow' as const }),
      execute: () => 'initial',
      result: z.string().transform((text) => text.toUpperCase()),
      after: (output: ToolOutput) => output,
    };
    const defined = tool(options);
    options.before = () => {
      throw new Error('replacement before');
    };
    options.execute = () => 'replacement';
    options.result = z.string().transform(() => 'replacement result');
    options.after = () => {
      throw new Error('replacement after');
    };
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'INITIAL' }],
    });
  });

  it('excludes policies and result conversion from the callback deadline', async () => {
    const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
    const onTimeout = vi.fn();
    const defined = tool({
      name: 'deadline',
      parameters: z.object({}),
      callbackTimeout: 0.02,
      async before() {
        await pause();
        return { action: 'allow' };
      },
      execute: () => 'done',
      result: z.string().transform((value) => {
        const end = performance.now() + 40;
        while (performance.now() < end) {
          /* Model a synchronous result validator. */
        }
        return value;
      }),
      async after(output) {
        await pause();
        return output;
      },
    });
    await expect(
      invokeFunctionTool(defined, {}, context, onTimeout),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'done' }],
    });
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('after policy admission', () => {
  it.each(['signal', 'native'] as const)(
    'withholds the result after %s revocation in an awaited after policy',
    async (boundary) => {
      const controller = new AbortController();
      const reason = new Error('revoked during after');
      let admitted = true;
      const execute = vi.fn(() => 'completed effect');
      const defined = tool({
        name: 'revoked_after',
        parameters: z.object({}),
        execute,
        async after(output) {
          await Promise.resolve();
          if (boundary === 'signal') controller.abort(reason);
          else admitted = false;
          return output;
        },
      });
      await expect(
        invokeFunctionTool(
          defined,
          {},
          { ...context, signal: controller.signal },
          vi.fn(),
          () => {
            if (!admitted) throw reason;
          },
        ),
      ).rejects.toBe(reason);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
});

describe('transformed tool inputs', () => {
  it.each([false, true])(
    'preserves transformed functions when a before policy is enabled: %s',
    async (withPolicy) => {
      const defined = tool({
        name: 'transformed',
        parameters: z.object({
          value: z.string().transform((value) => () => value),
        }),
        ...(withPolicy ? { before: () => ({ action: 'allow' as const }) } : {}),
        execute(args, info) {
          expect(args.value()).toBe('value');
          expect(info.effectiveArguments.value).toBe(args.value);
          return args.value();
        },
      });
      await expect(
        invokeFunctionTool(defined, { value: 'value' }, context, vi.fn()),
      ).resolves.toEqual({
        success: true,
        contentItems: [{ type: 'inputText', text: 'value' }],
      });
    },
  );
});

it('preserves explicit native namespaces without changing legacy tool references', () => {
  expect(toolRef('lookup')).toEqual({ kind: 'tool_ref', name: 'lookup' });
  const native = toolRef('lookup', 'mcp__reports');
  expect(native).toEqual({
    kind: 'tool_ref',
    name: 'lookup',
    namespace: 'mcp__reports',
  });
  expect(Object.isFrozen(native)).toBe(true);
});

it('enrolls only the configured executor tools in whole-result control', () => {
  const controlled = new Environment({
    url: 'wss://executor.invalid',
    cwd: '/tmp',
    tools: ['exec_command'],
    transformResult: () => ({ output: 'accepted' }),
  });
  expect(JSON.parse(executorPolicyRules(controlled, true))).toEqual([
    {
      name: 'exec_command',
      namespace: 'functions',
      timeout: 30,
      scope: 'thread_tree',
      result: true,
    },
  ]);
  const ordinary = new Environment({
    url: 'wss://executor.invalid',
    cwd: '/tmp',
    tools: ['apply_patch'],
  });
  expect(JSON.parse(executorPolicyRules(ordinary, false))).toEqual([
    {
      name: 'apply_patch',
      namespace: 'functions',
      timeout: 30,
      scope: 'root',
      result: false,
    },
  ]);
});

it.each([Number.NaN, Infinity, undefined, () => 'not JSON'])(
  'rejects an invalid JSON value behind an own __proto__ result key (%s)',
  async (invalid) => {
    const result = Object.fromEntries([
      ['structuredContent', Object.fromEntries([['__proto__', invalid]])],
    ]);
    const environment = new Environment({
      url: 'wss://executor.invalid',
      cwd: '/tmp',
      tools: ['exec_command'],
      // JavaScript callers can still return a value outside the public type.
      // @ts-expect-error Deliberately exercise runtime validation of invalid JSON.
      transformResult: () => result,
    });
    await expect(
      applyExecutorPolicy(
        environment,
        {} as Session,
        new Agent({ instructions: 'Pure codec fixture.' }),
        undefined,
        context.submission,
        {
          phase: 'after',
          tool_name: { name: 'exec_command', namespace: 'functions' },
          thread_id: 'root',
          turn_id: 't',
          call_id: 'c',
          result: {},
        },
        context.signal,
        vi.fn(),
      ),
    ).rejects.toThrow();
    expect(Object.prototype).not.toHaveProperty('ownKeyRetained');
  },
);

describe('Environment write policy', () => {
  const remote = { url: 'wss://executor.invalid', cwd: '/workspace' };

  it('defaults local and remote declarations to the existing strict roots wire format', () => {
    for (const environment of [
      new Environment(remote),
      Environment.local({ cwd: remote.cwd }),
    ]) {
      expect(environment.writePolicy).toBe('strict');
      expect(environment.writableRoots).toEqual([]);
      expect(environmentConfig(environment).writable_roots).toEqual([]);
      expect(Object.isFrozen(environment.writableRoots)).toBe(true);
    }
    expect(environmentConfig(new Environment(remote))).toEqual(
      environmentConfig(new Environment({ ...remote, writableRoots: [] })),
    );
  });

  it('requires an explicit remote legacy declaration without roots', () => {
    const environment = new Environment({ ...remote, writePolicy: 'legacy' });
    expect(environment.writePolicy).toBe('legacy');
    expect(environmentConfig(environment)).not.toHaveProperty('writable_roots');
    for (const writableRoots of [[], ['/output']]) {
      expect(
        () =>
          new Environment({ ...remote, writePolicy: 'legacy', writableRoots }),
      ).toThrow('Legacy write policy does not accept writableRoots');
    }
    expect(() =>
      Environment.local({ cwd: remote.cwd, writePolicy: 'legacy' as never }),
    ).toThrow('Legacy write policy requires a remote Environment');
    for (const writePolicy of [null, '', 'unknown', false]) {
      expect(
        () => new Environment({ ...remote, writePolicy: writePolicy as never }),
      ).toThrow('writePolicy must be strict or legacy');
    }
  });
});

describe('native function callback timeout policy', () => {
  const options = {
    name: 'slow',
    parameters: z.object({}),
    callbackTimeout: 0.005,
    timeoutBehavior: 'error_as_result' as const,
  };
  const expired = async (_: unknown, call: ToolContext) => {
    await new Promise<void>((resolve) =>
      call.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return 'late result';
  };

  it.each(['raise_exception', 'error_as_result'] as const)(
    'keeps an on-time synchronous result when unrelated queued work delays %s completion',
    async (timeoutBehavior) => {
      const formatter = vi.fn(() => 'must not replace success');
      const onTimeout = vi.fn();
      const defined = tool({
        ...options,
        callbackTimeout: 0.02,
        timeoutBehavior,
        timeoutErrorFunction: formatter,
        execute: () => 'on-time success',
      });
      queueMicrotask(() => {
        const end = performance.now() + 60;
        while (performance.now() < end) {
          /* Separate ready work can delay the SDK after the body returns. */
        }
      });
      await expect(
        invokeFunctionTool(defined, {}, context, onTimeout),
      ).resolves.toEqual({
        success: true,
        contentItems: [{ type: 'inputText', text: 'on-time success' }],
      });
      expect(formatter).not.toHaveBeenCalled();
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'formats failed text (async: %s) outside success schema and after',
    async (asyncFormatter) => {
      const result = z.number().transform(() => {
        throw new Error('success schema ran');
      });
      const after = vi.fn((output: ToolOutput) => output);
      const onTimeout = vi.fn();
      const formatter = vi.fn((call: ToolContext, error: ToolTimeoutError) => {
        expect(call.signal).toBe(context.signal);
        expect(call.signal.aborted).toBe(false);
        expect(call.originalArguments).toEqual({});
        expect(error).toBeInstanceOf(ToolTimeoutError);
        expect(error).toMatchObject({
          toolName: 'slow',
          timeoutSeconds: 0.005,
        });
        return asyncFormatter
          ? Promise.resolve('try another tool')
          : 'try another tool';
      });
      const defined = tool({
        ...options,
        result,
        after,
        execute: expired as never,
        timeoutErrorFunction: formatter,
      });
      await expect(
        invokeFunctionTool(defined, {}, context, onTimeout),
      ).resolves.toEqual({
        success: false,
        contentItems: [{ type: 'inputText', text: 'try another tool' }],
      });
      expect(formatter).toHaveBeenCalledOnce();
      expect(after).not.toHaveBeenCalled();
      expect(onTimeout).not.toHaveBeenCalled();
    },
  );

  it.each(['return', 'reject'] as const)(
    'joins callback cleanup before timeout formatting when cleanup will %s',
    async (outcome) => {
      const aborted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const effects: string[] = [];
      const formatter = vi.fn(() => {
        expect(effects).toEqual(['entered', 'cleanup']);
        return 'deadline';
      });
      const defined = tool({
        ...options,
        timeoutErrorFunction: formatter,
        async execute(_, call) {
          effects.push('entered');
          call.signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          await release.promise;
          expect(call.signal.aborted).toBe(true);
          effects.push('cleanup');
          if (outcome === 'reject') throw new Error('cleanup rejection');
          return 'late success';
        },
      });
      let settled = false;
      const pending = invokeFunctionTool(defined, {}, context, vi.fn()).finally(
        () => {
          settled = true;
        },
      );
      try {
        await aborted.promise;
        expect(settled).toBe(false);
        expect(formatter).not.toHaveBeenCalled();
        release.resolve();
        await expect(pending).resolves.toEqual({
          success: false,
          contentItems: [{ type: 'inputText', text: 'deadline' }],
        });
        expect(effects).toEqual(['entered', 'cleanup']);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(['return', 'reject'] as const)(
    'detects elapsed deadline before timer delivery on synchronous %s',
    async (outcome) => {
      const defined = tool({
        ...options,
        execute() {
          const end = performance.now() + 15;
          while (performance.now() < end) {
            /* Occupy the event loop beyond the deadline. */
          }
          if (outcome === 'reject') throw new Error('late rejection');
          return 'late success';
        },
      });
      await expect(
        invokeFunctionTool(defined, {}, context, vi.fn()),
      ).resolves.toEqual({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: 'Tool slow exceeded its callback timeout',
          },
        ],
      });
    },
  );

  it('notifies the exception owner immediately but joins rejecting cleanup', async () => {
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const formatter = vi.fn(() => 'unused');
    const onTimeout = vi.fn();
    const defined = tool({
      ...options,
      timeoutBehavior: 'raise_exception',
      timeoutErrorFunction: formatter,
      async execute(_, call) {
        call.signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        await release.promise;
        throw new Error('cleanup failed');
      },
    });
    const pending = invokeFunctionTool(defined, {}, context, onTimeout).catch(
      (error: unknown) => error,
    );
    try {
      await aborted.promise;
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(formatter).not.toHaveBeenCalled();
      release.resolve();
      expect(await pending).toBe(onTimeout.mock.calls[0]![0]);
      expect(await pending).toBeInstanceOf(ToolTimeoutError);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it.each([
    new ToolTimeoutError('slow', 0.005),
    Object.assign(new Error('user timeout'), { name: 'TimeoutError' }),
  ])('does not convert a callback-thrown lookalike: %s', async (failure) => {
    const formatter = vi.fn(() => 'unused');
    const defined = tool({
      ...options,
      callbackTimeout: 1,
      timeoutErrorFunction: formatter,
      execute() {
        throw failure;
      },
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).rejects.toBe(failure);
    expect(formatter).not.toHaveBeenCalled();
  });

  it('leaves timeout options inactive without a deadline and keeps normal after behavior', async () => {
    const formatter = vi.fn(() => 'unused');
    const after = vi.fn((output: ToolOutput) => output);
    const defined = tool({
      ...options,
      callbackTimeout: undefined,
      timeoutErrorFunction: formatter,
      result: z.string().transform((value) => value.toUpperCase()),
      after,
      execute: () => 'done',
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'DONE' }],
    });
    expect(after).toHaveBeenCalledOnce();
    expect(formatter).not.toHaveBeenCalled();
  });

  it('propagates formatter exceptions without running after', async () => {
    const failure = new Error('formatter failed');
    const after = vi.fn((output: ToolOutput) => output);
    const defined = tool({
      ...options,
      execute: expired,
      after,
      timeoutErrorFunction() {
        throw failure;
      },
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn()),
    ).rejects.toBe(failure);
    expect(after).not.toHaveBeenCalled();
  });

  it.each(['cleanup', 'formatter'] as const)(
    'prevents publication after parent cancellation during %s',
    async (stage) => {
      const controller = new AbortController();
      const failure = new Error('parent cancelled');
      const formatter = vi.fn(async () => {
        controller.abort(failure);
        return 'must not publish';
      });
      const defined = tool({
        ...options,
        timeoutErrorFunction: formatter,
        async execute(_, call) {
          await expired(_, call);
          if (stage === 'cleanup') controller.abort(failure);
          return 'late';
        },
      });
      await expect(
        invokeFunctionTool(
          defined,
          {},
          { ...context, signal: controller.signal },
          vi.fn(),
        ),
      ).rejects.toBe(failure);
      expect(formatter).toHaveBeenCalledTimes(stage === 'formatter' ? 1 : 0);
    },
  );

  it('revalidates native admission before and after an awaited formatter', async () => {
    let active = true;
    const failure = new Error('native admission revoked');
    const defined = tool({
      ...options,
      execute: expired,
      async timeoutErrorFunction() {
        await Promise.resolve();
        active = false;
        return 'must not publish';
      },
    });
    await expect(
      invokeFunctionTool(defined, {}, context, vi.fn(), () => {
        if (!active) throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
