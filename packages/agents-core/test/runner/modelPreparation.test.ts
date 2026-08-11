import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  FunctionTool,
  Handoff,
  ModelRequest,
  Runner,
  RunContext,
  RunState,
  ToolNameCollisionPolicy,
  Usage,
  UserError,
  handoff,
  protocol,
  run,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  tool,
  toolNamespace,
  type Span,
  type Trace,
  type TracingProcessor,
} from '../../src';
import logger from '../../src/logger';
import { FUNCTION_TOOL_NAMESPACE } from '../../src/toolIdentity';
import { prepareAgentArtifacts } from '../../src/runner/modelPreparation';
import { withTrace } from '../../src/tracing/context';
import {
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_RESPONSE_BASIC,
  ScriptedModelProvider,
} from '../stubs';
import { ScriptedModel, modelResponse } from '../../src/testing';

class RecordingModel extends ScriptedModel {
  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

class RecordingTracingProcessor implements TracingProcessor {
  readonly spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(_span: Span<any>): Promise<void> {}
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

function functionTool(
  name: string,
  isEnabled: boolean = true,
  description: string = `Tool ${name}`,
  execute: () => string | Promise<string> = async () => name,
): FunctionTool<any, any, any> {
  return tool({
    name,
    description,
    parameters: z.object({}),
    isEnabled,
    execute,
  });
}

async function expectRejectedBeforeModelRequest(args: {
  tools?: FunctionTool<any, any, any>[];
  handoffs?: Handoff<any, any>[];
  expectedMessage: string;
  policy?: ToolNameCollisionPolicy;
}): Promise<void> {
  const model = new RecordingModel([modelResponse(TEST_MODEL_RESPONSE_BASIC)]);
  const agent = new Agent({
    name: 'Collision agent',
    model,
    tools: args.tools,
    handoffs: args.handoffs,
  });

  await expect(
    run(agent, 'hello', {
      toolNameCollisionPolicy: args.policy ?? 'error',
    }),
  ).rejects.toMatchObject({
    name: UserError.name,
    message: args.expectedMessage,
  });
  expect(model.requests).toHaveLength(0);
}

describe('model-visible tool name validation', () => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());

  beforeEach(() => {
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const remediation =
    'Function tools and handoffs must have unique routed names. Assign unique tool names or toolNameOverride values, or use a namespace.';

  it.each([false, true])(
    'redacts collision names from runner span errors (stream: %s)',
    async (stream) => {
      const secretToolName = 'SECRET_COLLISION_TRACE';
      const processor = new RecordingTracingProcessor();
      const model = new RecordingModel([
        modelResponse(TEST_MODEL_RESPONSE_BASIC),
      ]);
      const agent = new Agent({
        name: 'Trace collision agent',
        model,
        tools: [functionTool(secretToolName), functionTool(secretToolName)],
      });
      const runner = new Runner({
        toolNameCollisionPolicy: 'error',
        traceIncludeSensitiveData: false,
      });
      setTraceProcessors([processor]);
      setTracingDisabled(false);

      try {
        if (stream) {
          const result = await runner.run(agent, 'hello', { stream: true });
          await expect(result.completed).rejects.toThrow(secretToolName);
        } else {
          await expect(runner.run(agent, 'hello')).rejects.toThrow(
            secretToolName,
          );
        }

        const spanErrors = processor.spansEnded
          .map((span) => span.error)
          .filter((error) => error !== null);
        expect(spanErrors.length).toBeGreaterThan(0);
        expect(JSON.stringify(spanErrors)).not.toContain(secretToolName);
      } finally {
        setTraceProcessors([]);
        setTracingDisabled(true);
      }
    },
  );

  it('rejects duplicate enabled function tools before a model request', async () => {
    await expectRejectedBeforeModelRequest({
      tools: [functionTool('duplicate'), functionTool('duplicate')],
      expectedMessage: `Duplicate enabled tool name found: 'duplicate' (2 function tools). ${remediation}`,
    });
  });

  it('rejects duplicate enabled function tools within the same namespace', async () => {
    const duplicateTools = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [functionTool('duplicate'), functionTool('duplicate')],
    });

    await expectRejectedBeforeModelRequest({
      tools: [...duplicateTools],
      policy: 'warn',
      expectedMessage: `Duplicate enabled tool name found: 'crm.duplicate' (2 function tools). ${remediation}`,
    });
  });

  it.each<ToolNameCollisionPolicy>(['warn', 'error'])(
    'rejects duplicate deferred top-level function tools under the %s policy',
    async (policy) => {
      const first = functionTool('duplicate');
      const second = functionTool('duplicate');
      first.deferLoading = true;
      second.deferLoading = true;

      await expectRejectedBeforeModelRequest({
        tools: [first, second],
        policy,
        expectedMessage: `Duplicate enabled tool name found: 'duplicate' (2 function tools). ${remediation}`,
      });
    },
  );

  it('keeps bare and deferred functions with the same public name distinct', async () => {
    const bare = functionTool('lookup');
    const deferred = functionTool('lookup');
    deferred.deferLoading = true;
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Category-aware function agent',
      model,
      tools: [bare, deferred],
    });

    await run(agent, 'hello');

    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'lookup', deferLoading: false }),
      expect.objectContaining({ name: 'lookup', deferLoading: true }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each<ToolNameCollisionPolicy>(['warn', 'error'])(
    'rejects a namespace reserved for deferred top-level tools under the %s policy',
    async (policy) => {
      const reservedNamespaceTool = functionTool('lookup');
      Object.defineProperty(reservedNamespaceTool, FUNCTION_TOOL_NAMESPACE, {
        value: 'lookup',
      });

      await expectRejectedBeforeModelRequest({
        tools: [reservedNamespaceTool],
        policy,
        expectedMessage:
          'Responses tool search reserves same-name namespaces for deferred top-level function tools. Rename the namespace or tool name to avoid ambiguous dispatch.',
      });
    },
  );

  it('rejects duplicate enabled handoffs before a model request', async () => {
    const first = handoff(new Agent({ name: 'First target' }), {
      toolNameOverride: 'duplicate',
    });
    const second = handoff(new Agent({ name: 'Second target' }), {
      toolNameOverride: 'duplicate',
    });

    await expectRejectedBeforeModelRequest({
      handoffs: [first, second],
      expectedMessage: `Duplicate enabled tool name found: 'duplicate' (2 handoffs). ${remediation}`,
    });
  });

  it('rejects mixed enabled function tool and handoff names before a model request', async () => {
    const duplicateHandoff = handoff(new Agent({ name: 'Target' }), {
      toolNameOverride: 'duplicate',
    });

    await expectRejectedBeforeModelRequest({
      tools: [functionTool('duplicate')],
      handoffs: [duplicateHandoff],
      expectedMessage: `Duplicate enabled tool name found: 'duplicate' (function tool and handoff). ${remediation}`,
    });
  });

  it('warns by default and exposes only the last function tool', async () => {
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Last function wins agent',
      model,
      tools: [
        functionTool('duplicate', true, 'First tool'),
        functionTool('duplicate', true, 'Second tool'),
      ],
    });

    await run(agent, 'hello');

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: 'duplicate',
        description: 'Second tool',
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `Duplicate enabled tool name found: 'duplicate' (2 function tools). ${remediation} Only the current dispatch winner will be exposed.`,
    );
  });

  it('dispatches the same last function tool that was exposed to the model', async () => {
    const firstExecute = vi.fn(async () => 'first');
    const secondExecute = vi.fn(async () => 'second');
    const model = new RecordingModel([
      modelResponse({
        output: [
          {
            ...TEST_MODEL_FUNCTION_CALL,
            name: 'duplicate',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      }),
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Dispatch winner agent',
      model,
      tools: [
        functionTool('duplicate', true, 'First tool', firstExecute),
        functionTool('duplicate', true, 'Second tool', secondExecute),
      ],
    });

    await run(agent, 'hello');

    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({ description: 'Second tool' }),
    ]);
    expect(firstExecute).not.toHaveBeenCalled();
    expect(secondExecute).toHaveBeenCalledTimes(1);
  });

  it('warns by default and gives handoffs priority over function tools', async () => {
    const firstHandoff = handoff(new Agent({ name: 'First target' }), {
      toolNameOverride: 'duplicate',
      toolDescriptionOverride: 'First handoff',
    });
    const secondHandoff = handoff(new Agent({ name: 'Second target' }), {
      toolNameOverride: 'duplicate',
      toolDescriptionOverride: 'Second handoff',
    });
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Handoff wins agent',
      model,
      tools: [functionTool('duplicate')],
      handoffs: [firstHandoff, secondHandoff],
    });

    await run(agent, 'hello');

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools).toEqual([]);
    expect(model.requests[0]?.handoffs).toEqual([
      expect.objectContaining({
        toolName: 'duplicate',
        toolDescription: 'Second handoff',
      }),
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `Duplicate enabled tool name found: 'duplicate' (function tool and 2 handoffs). ${remediation} Only the current dispatch winner will be exposed.`,
    );
  });

  it('ignores disabled function tools and handoffs when checking names', async () => {
    const enabledHandoff = handoff(new Agent({ name: 'Enabled target' }), {
      toolNameOverride: 'handoff_duplicate',
    });
    const disabledHandoff = handoff(new Agent({ name: 'Disabled target' }), {
      toolNameOverride: 'handoff_duplicate',
      isEnabled: false,
    });
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Filtered capabilities agent',
      model,
      tools: [
        functionTool('function_duplicate'),
        functionTool('function_duplicate', false),
      ],
      handoffs: [enabledHandoff, disabledHandoff],
    });

    await run(agent, 'hello');

    expect(model.requests).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'function_duplicate' }),
    ]);
    expect(model.requests[0]?.handoffs).toEqual([
      expect.objectContaining({ toolName: 'handoff_duplicate' }),
    ]);
  });

  it('filters disabled runtime-loaded function tools before validation', async () => {
    const configured = functionTool('lookup');
    const disabledRuntime = functionTool('lookup', false);
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Runtime filtering agent',
      model,
      tools: [configured],
    });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    state.recordToolSearchRuntimeTools(
      agent,
      {
        type: 'tool_search_output',
        status: 'completed',
        tools: [],
      } as protocol.ToolSearchOutputItem,
      [disabledRuntime],
    );

    await run(agent, state);

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'lookup' }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('evaluates runtime-loaded tools against their public owning agent', async () => {
    const publicAgent = new Agent({
      name: 'Public sandbox agent',
    }) as Agent<unknown, any>;
    const executionAgent = new Agent({
      name: 'Prepared sandbox agent',
    }) as Agent<unknown, any>;
    const evaluatedAgents: Agent<any, any>[] = [];
    const runtimeTool = tool({
      name: 'runtime_lookup',
      description: 'Runtime lookup.',
      parameters: z.object({}),
      isEnabled: ({ agent }) => {
        evaluatedAgents.push(agent);
        return agent === publicAgent;
      },
      execute: async () => 'runtime',
    });
    const state = new RunState(new RunContext(), 'hello', publicAgent, 1);
    state.recordToolSearchRuntimeTools(
      publicAgent,
      {
        type: 'tool_search_output',
        status: 'completed',
        tools: [],
      } as protocol.ToolSearchOutputItem,
      [runtimeTool],
    );

    const artifacts = await withTrace('runtime tool owner test', async () =>
      prepareAgentArtifacts(state, executionAgent),
    );

    expect(evaluatedAgents).toEqual([publicAgent]);
    expect(artifacts.tools).toContain(runtimeTool);
  });

  it('keeps equal bare names distinct when namespaces disambiguate routing', async () => {
    const [crmLookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [functionTool('lookup')],
    });
    const [billingLookup] = toolNamespace({
      name: 'billing',
      description: 'Billing tools',
      tools: [functionTool('lookup')],
    });
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const dottedHandoff = handoff(new Agent({ name: 'Dotted target' }), {
      toolNameOverride: 'crm.lookup',
    });
    const agent = new Agent({
      name: 'Namespaced capabilities agent',
      model,
      tools: [functionTool('lookup'), crmLookup!, billingLookup!],
      handoffs: [dottedHandoff],
    });

    await run(agent, 'hello');

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'lookup' }),
      expect.objectContaining({ name: 'lookup', namespace: 'crm' }),
      expect.objectContaining({ name: 'lookup', namespace: 'billing' }),
    ]);
    expect(model.requests[0]?.handoffs).toEqual([
      expect.objectContaining({ toolName: 'crm.lookup' }),
    ]);
  });

  it('uses the same pre-request validation for streaming runs', async () => {
    const duplicateHandoff = handoff(new Agent({ name: 'Stream target' }), {
      toolNameOverride: 'duplicate',
    });
    const model = new ScriptedModel([modelResponse(TEST_MODEL_RESPONSE_BASIC)]);
    const getResponse = vi.spyOn(model, 'getResponse');
    const getStreamedResponse = vi.spyOn(model, 'getStreamedResponse');
    const agent = new Agent({
      name: 'Streaming collision agent',
      model,
      tools: [functionTool('duplicate')],
      handoffs: [duplicateHandoff],
    });

    const result = await run(agent, 'hello', {
      stream: true,
      toolNameCollisionPolicy: 'error',
    });

    await expect(result.completed).rejects.toMatchObject({
      name: UserError.name,
      message: `Duplicate enabled tool name found: 'duplicate' (function tool and handoff). ${remediation}`,
    });
    expect(getResponse).not.toHaveBeenCalled();
    expect(getStreamedResponse).not.toHaveBeenCalled();
  });

  it('redacts colliding names while keeping remediation actionable', async () => {
    const redaction = vi
      .spyOn(logger, 'dontLogToolData', 'get')
      .mockReturnValue(true);
    try {
      await expectRejectedBeforeModelRequest({
        tools: [
          functionTool('sensitive_duplicate'),
          functionTool('sensitive_duplicate'),
        ],
        expectedMessage:
          'Duplicate enabled function tool or handoff names found. ' +
          remediation,
        policy: 'error',
      });
    } finally {
      redaction.mockRestore();
    }
  });

  it('redacts warning details while keeping remediation actionable', async () => {
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(true);
    const model = new RecordingModel([
      modelResponse(TEST_MODEL_RESPONSE_BASIC),
    ]);
    const agent = new Agent({
      name: 'Redacted warning agent',
      model,
      tools: [
        functionTool('sensitive_duplicate'),
        functionTool('sensitive_duplicate'),
      ],
    });

    await run(agent, 'hello');

    expect(model.requests[0]?.tools).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Tool name collision detected. Assign unique routed tool names or enable tool data logging for details. Only the current dispatch winner will be exposed.',
    );
  });
});
