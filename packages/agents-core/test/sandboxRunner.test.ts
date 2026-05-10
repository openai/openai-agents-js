import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, type AgentOutputType } from '../src/agent';
import { handoff } from '../src/handoff';
import { UserError } from '../src/errors';
import type {
  ApplyPatchOperation,
  ApplyPatchResult,
  Editor,
} from '../src/editor';
import {
  type Model,
  type ModelRequest,
  type ModelResponse,
} from '../src/model';
import { RunContext } from '../src/runContext';
import {
  run,
  RunItemStreamEvent,
  RunState,
  Runner,
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  createAgentSpan,
  getCurrentSpan,
  setCurrentSpan,
  withTrace,
  tool,
  type Span,
  type Trace,
  type TracingProcessor,
} from '../src';
import { SandboxRuntimeManager } from '../src/sandbox/runtime';
import {
  finalizeSandboxRuntime,
  prepareSandboxInterruptedTurnResume,
} from '../src/runner/sandbox';
import { serializeSandboxRuntimeState } from '../src/sandbox/runtime/sessionSerialization';
import { deserializeSandboxSessionStateEntry } from '../src/sandbox/runtime/sessionState';
import {
  cleanupSandboxSession,
  registerSandboxPreStopHook,
  runSandboxSessionPreStopHooks,
} from '../src/sandbox/runtime/sessionLifecycle';
import {
  Capability,
  Entry,
  filesystem,
  Manifest,
  SANDBOX_SESSION_STATE_VERSION,
  shell,
  skills,
  SandboxAgent,
  normalizeSandboxClientCreateArgs,
} from '../src/sandbox';
import type { Tool } from '../src/tool';
import { shellTool } from '../src/tool';
import type {
  SandboxClient,
  SandboxClientCreateArgs,
  SandboxClientOptions,
  SandboxSessionLike,
  SandboxSessionSerializationOptions,
  SandboxSessionState,
} from '../src/sandbox';
import { Usage } from '../src/usage';
import * as protocol from '../src/types/protocol';
import {
  FakeModel,
  FakeModelProvider,
  FakeShell,
  fakeModelMessage,
} from './stubs';

class StubEditor implements Editor {
  async createFile(
    _operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    return {};
  }

  async updateFile(
    _operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    return {};
  }

  async deleteFile(
    _operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    return {};
  }
}

class RecordingFakeModel extends FakeModel {
  public readonly requests: ModelRequest[] = [];

  override async getResponse(request: ModelRequest) {
    this.requests.push(request);
    return await super.getResponse(request);
  }
}

class RecordingStreamingModel implements Model {
  public readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this test model.');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('No response found');
    }
    yield {
      type: 'response_done',
      response: {
        id: `stream-${this.requests.length}`,
        usage: {
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        output: response.output,
      },
    } as protocol.StreamEvent;
  }
}

class OpenAIChatCompletionsModel extends RecordingFakeModel {}

class RecordingTracingProcessor implements TracingProcessor {
  public readonly spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {
    // no-op
  }

  async onTraceEnd(_trace: Trace): Promise<void> {
    // no-op
  }

  async onSpanStart(_span: Span<any>): Promise<void> {
    // no-op
  }

  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }

  async shutdown(): Promise<void> {
    // no-op
  }

  async forceFlush(): Promise<void> {
    // no-op
  }
}

class ShellToolCapability extends Capability {
  readonly type = 'shell_tool';

  override tools() {
    return [
      shellTool({
        name: 'shell',
        shell: new FakeShell(),
      }),
    ];
  }
}

class ManifestFileCapability extends Capability {
  readonly type = 'manifest_file';

  override processManifest(manifest: Manifest): Manifest {
    manifest.entries['generated.txt'] = {
      type: 'file',
      content: 'generated\n',
    };
    return manifest;
  }
}

class SamplingRecorderCapability extends Capability {
  readonly type = 'sampling_recorder';
  readonly calls: Record<string, unknown>[];

  constructor(calls: Record<string, unknown>[] = []) {
    super();
    this.calls = calls;
  }

  override clone(): this {
    return new SamplingRecorderCapability(this.calls) as this;
  }

  override samplingParams(
    samplingParams: Record<string, unknown>,
  ): Record<string, unknown> {
    this.calls.push(samplingParams);
    return {};
  }
}

class ReservedFunctionNameCapability extends Capability {
  readonly type = 'reserved_function_name';

  override tools(): Tool<any>[] {
    return [
      {
        type: 'function',
        name: 'shell',
        description: 'compatibility shell wrapper',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        strict: true,
        invoke: async () => 'ok',
        needsApproval: async () => false,
        isEnabled: async () => true,
      } as Tool<any>,
    ];
  }
}

type FakeSandboxSessionState = SandboxSessionState & {
  sessionId: string;
};

class FakeSandboxClient implements SandboxClient<
  SandboxClientOptions,
  FakeSandboxSessionState
> {
  readonly backendId = 'fake-sandbox';
  readonly createCalls: Array<{
    manifest: Manifest;
    options?: SandboxClientOptions;
    snapshot?: SandboxClientCreateArgs['snapshot'];
    concurrencyLimits?: SandboxClientCreateArgs['concurrencyLimits'];
    archiveLimits?: SandboxClientCreateArgs['archiveLimits'];
  }> = [];
  readonly rawCreateCalls: Array<
    SandboxClientCreateArgs<SandboxClientOptions> | Manifest | undefined
  > = [];
  readonly resumeCalls: Array<{
    state: FakeSandboxSessionState;
    archiveLimits?: SandboxClientCreateArgs['archiveLimits'];
  }> = [];
  readonly serializedStates: Array<FakeSandboxSessionState> = [];
  readonly serializedOptions: SandboxSessionSerializationOptions[] = [];
  readonly closeCalls: string[] = [];
  readonly shutdownCalls: Array<{ sessionId: string; reason?: string }> = [];
  readonly startCalls: Array<{ sessionId: string; reason?: string }> = [];
  readonly createdSessions: Array<SandboxSessionLike<FakeSandboxSessionState>> =
    [];
  readonly resumedSessions: Array<SandboxSessionLike<FakeSandboxSessionState>> =
    [];
  readonly lifecycleCalls: Array<{
    hook: string;
    sessionId: string;
    reason?: string;
  }> = [];
  readonly execCommandCalls: unknown[] = [];
  private nextSessionId = 1;

  async create(
    args?: SandboxClientCreateArgs<SandboxClientOptions> | Manifest,
    manifestOptions?: SandboxClientOptions,
  ): Promise<SandboxSessionLike<FakeSandboxSessionState>> {
    this.rawCreateCalls.push(args);
    const { manifest, options, snapshot, concurrencyLimits, archiveLimits } =
      normalizeSandboxClientCreateArgs(args, manifestOptions);
    this.createCalls.push({
      manifest,
      options,
      snapshot,
      concurrencyLimits,
      archiveLimits,
    });
    const session = this.makeSession({
      manifest,
      sessionId: `session-${this.nextSessionId++}`,
    });
    this.createdSessions.push(session);
    return session;
  }

  async resume(
    state: FakeSandboxSessionState,
    options: { archiveLimits?: SandboxClientCreateArgs['archiveLimits'] } = {},
  ): Promise<SandboxSessionLike<FakeSandboxSessionState>> {
    this.resumeCalls.push({ state, archiveLimits: options.archiveLimits });
    const session = this.makeSession(state);
    this.resumedSessions.push(session);
    return session;
  }

  makeSession(
    state: FakeSandboxSessionState,
  ): SandboxSessionLike<FakeSandboxSessionState> {
    return {
      state,
      createEditor: () => new StubEditor(),
      execCommand: async (args) => {
        this.execCommandCalls.push(args);
        return 'ok';
      },
      materializeEntry: async ({ path, entry }) => {
        state.manifest = new Manifest({
          root: state.manifest.root,
          entries: {
            ...state.manifest.entries,
            [path]: structuredClone(entry as Entry),
          },
        });
      },
      applyManifest: async (manifest) => {
        state.manifest = new Manifest({
          root: state.manifest.root,
          entries: {
            ...state.manifest.entries,
            ...structuredClone(manifest.entries),
          },
          environment: {
            ...Object.fromEntries(
              Object.entries(state.manifest.environment).map(([key, value]) => [
                key,
                value.normalized(),
              ]),
            ),
            ...Object.fromEntries(
              Object.entries(manifest.environment).map(([key, value]) => [
                key,
                value.normalized(),
              ]),
            ),
          },
        });
      },
      ...this.lifecycleHandlers(state),
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
    };
  }

  async serializeSessionState(
    state: FakeSandboxSessionState,
    options: SandboxSessionSerializationOptions = {},
  ): Promise<Record<string, unknown>> {
    this.serializedStates.push(state);
    this.serializedOptions.push(options);
    return {
      root: state.manifest.root,
      sessionId: state.sessionId,
    };
  }

  async deserializeSessionState(
    state: Record<string, unknown>,
  ): Promise<FakeSandboxSessionState> {
    return {
      manifest: new Manifest({
        root: String(state.root),
      }),
      sessionId: String(state.sessionId),
    };
  }

  protected lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      close: async () => {
        this.closeCalls.push(state.sessionId);
      },
    };
  }
}

class NonPersistentFakeSandboxClient extends FakeSandboxClient {
  override async resume(
    state: FakeSandboxSessionState,
  ): Promise<SandboxSessionLike<FakeSandboxSessionState>> {
    if (this.closeCalls.includes(state.sessionId)) {
      throw new Error(`Cannot resume closed session ${state.sessionId}`);
    }
    return await super.resume(state);
  }

  canPersistOwnedSessionState(): boolean {
    return false;
  }
}

class RecoverableCloseFakeSandboxClient extends FakeSandboxClient {
  readonly closeAttempts: string[] = [];
  shouldFailClose = true;

  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      close: async () => {
        this.closeAttempts.push(state.sessionId);
        if (this.shouldFailClose) {
          throw new Error(`Failed to close ${state.sessionId}`);
        }
        this.closeCalls.push(state.sessionId);
      },
    };
  }
}

class SelectiveCloseFailureFakeSandboxClient extends FakeSandboxClient {
  readonly closeAttempts: string[] = [];

  constructor(private readonly failingSessionIds: Set<string>) {
    super();
  }

  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      close: async () => {
        this.closeAttempts.push(state.sessionId);
        if (this.failingSessionIds.has(state.sessionId)) {
          throw new Error(`Failed to close ${state.sessionId}`);
        }
        this.closeCalls.push(state.sessionId);
      },
    };
  }
}

class DefaultSnapshotFakeSandboxClient extends FakeSandboxClient {
  readonly supportsDefaultOptions = true;
}

class SerializedResumeFakeSandboxClient extends FakeSandboxClient {
  canReusePreservedOwnedSession(): boolean {
    return false;
  }
}

class ClosedHandleSerializedResumeFakeSandboxClient extends SerializedResumeFakeSandboxClient {
  override makeSession(
    state: FakeSandboxSessionState,
  ): SandboxSessionLike<FakeSandboxSessionState> {
    const session = super.makeSession(state);
    let closed = false;
    const close = session.close?.bind(session);
    const execCommand = session.execCommand?.bind(session);
    return {
      ...session,
      execCommand: async (args) => {
        if (closed) {
          throw new Error(`Cannot execute against closed ${state.sessionId}`);
        }
        return await execCommand!(args);
      },
      close: async () => {
        closed = true;
        await close?.();
      },
    };
  }
}

class ShutdownOnlyFakeSandboxClient extends FakeSandboxClient {
  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      shutdown: async (options) => {
        this.shutdownCalls.push({
          sessionId: state.sessionId,
          reason: options?.reason,
        });
      },
    };
  }
}

class StartableFakeSandboxClient extends FakeSandboxClient {
  private readonly startedSessionIds = new Set<string>();

  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      ...super.lifecycleHandlers(state),
      running: async () => this.startedSessionIds.has(state.sessionId),
      start: async (options) => {
        this.startCalls.push({
          sessionId: state.sessionId,
          reason: options?.reason,
        });
        this.startedSessionIds.add(state.sessionId);
      },
    };
  }
}

class StartOnlyFakeSandboxClient extends FakeSandboxClient {
  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      ...super.lifecycleHandlers(state),
      start: async (options) => {
        this.startCalls.push({
          sessionId: state.sessionId,
          reason: options?.reason,
        });
      },
    };
  }
}

class StandardLifecycleFakeSandboxClient extends FakeSandboxClient {
  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    const record = (hook: string, reason?: string) => {
      this.lifecycleCalls.push({
        hook,
        sessionId: state.sessionId,
        reason,
      });
    };
    return {
      preStop: async (options) => {
        record('preStop', options?.reason);
      },
      stop: async (options) => {
        record('stop', options?.reason);
      },
      shutdown: async (options) => {
        record('shutdown', options?.reason);
      },
      delete: async (options) => {
        record('delete', options?.reason);
      },
    };
  }
}

class FailingStopLifecycleFakeSandboxClient extends StandardLifecycleFakeSandboxClient {
  protected override lifecycleHandlers(
    state: FakeSandboxSessionState,
  ): Partial<SandboxSessionLike<FakeSandboxSessionState>> {
    return {
      ...super.lifecycleHandlers(state),
      stop: async (options) => {
        this.lifecycleCalls.push({
          hook: 'stop',
          sessionId: state.sessionId,
          reason: options?.reason,
        });
        throw new Error('stop failed');
      },
    };
  }
}

function fakeSandboxSessionStateEnvelope(
  providerState: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): any {
  return {
    version: SANDBOX_SESSION_STATE_VERSION,
    backendId: 'fake-sandbox',
    manifest: {
      version: 1,
      root: '/workspace',
      entries: {},
      environment: {},
    },
    workspaceReady: true,
    providerState,
    ...overrides,
  };
}

describe('sandbox runner integration', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider(new FakeModelProvider());
  });

  afterEach(() => {
    setTraceProcessors([]);
    setTracingDisabled(true);
  });

  it('requires RunConfig.sandbox when execution reaches a SandboxAgent', async () => {
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
    });
    const handoffToSandbox = handoff(sandboxAgent);
    const rootModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'handoff-1',
            type: 'function_call',
            name: handoffToSandbox.toolName,
            callId: 'handoff-1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      },
    ]);
    const rootAgent = new Agent({
      name: 'RootAgent',
      model: rootModel,
      handoffs: [handoffToSandbox],
    });

    await expect(run(rootAgent, 'Hello')).rejects.toThrow(
      new UserError('SandboxAgent execution requires `RunConfig.sandbox`.'),
    );
  });

  it('hands off from a plain agent to a sandbox agent and prepares sandbox instructions', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const handoffToSandbox = handoff(sandboxAgent);
    const rootModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'handoff-1',
            type: 'function_call',
            name: handoffToSandbox.toolName,
            callId: 'handoff-1',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      },
    ]);
    const rootAgent = new Agent({
      name: 'RootAgent',
      model: rootModel,
      handoffs: [handoffToSandbox],
    });

    const result = await run(rootAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.finalOutput).toBe('sandbox done');
    expect(client.createCalls).toHaveLength(1);
    expect(rootModel.requests[0]?.systemInstructions).toBe('');
    expect(sandboxModel.requests[0]?.systemInstructions).toContain(
      '# Filesystem',
    );
  });

  it('does not pass an implicit default manifest when creating sessions', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.finalOutput).toBe('sandbox done');
    expect(client.rawCreateCalls[0]).not.toHaveProperty('manifest');
    expect(client.createCalls[0]?.manifest.root).toBe('/workspace');
  });

  it('accepts manifest instances and init objects in per-run sandbox config', async () => {
    const client = new FakeSandboxClient();
    const manifestInstance = new Manifest({
      entries: {
        'instance.txt': {
          type: 'file',
          content: 'instance',
        },
      },
    });
    const manifestInit = {
      entries: {
        'init.txt': {
          type: 'file' as const,
          content: 'init',
        },
      },
    };

    for (const [name, manifest] of [
      ['instance', manifestInstance],
      ['init', manifestInit],
    ] as const) {
      const sandboxAgent = new SandboxAgent({
        name: `SandboxWorker-${name}`,
        model: new RecordingFakeModel([
          {
            output: [fakeModelMessage(`${name} sandbox done`)],
            usage: new Usage(),
          },
        ]),
      });

      const result = await run(sandboxAgent, 'Hello', {
        sandbox: {
          client,
          manifest,
        },
      });

      expect(result.finalOutput).toBe(`${name} sandbox done`);
    }

    (manifestInstance.entries['instance.txt'] as { content: string }).content =
      'mutated-instance';
    (manifestInit.entries['init.txt'] as { content: string }).content =
      'mutated-init';

    expect(client.createCalls).toHaveLength(2);
    expect(
      (
        client.createCalls[0]?.manifest.entries['instance.txt'] as {
          content: string;
        }
      ).content,
    ).toBe('instance');
    expect(
      (
        client.createCalls[1]?.manifest.entries['init.txt'] as {
          content: string;
        }
      ).content,
    ).toBe('init');
  });

  it('normalizes manifest instances and init objects in sandbox client create args', () => {
    const manifestInstance = new Manifest({
      entries: {
        'instance.txt': {
          type: 'file',
          content: 'instance',
        },
      },
    });
    const manifestInit = {
      entries: {
        'init.txt': {
          type: 'file' as const,
          content: 'init',
        },
      },
    };

    const normalizedInstance = normalizeSandboxClientCreateArgs({
      manifest: manifestInstance,
    });
    const normalizedInit = normalizeSandboxClientCreateArgs({
      manifest: manifestInit,
    });
    (manifestInstance.entries['instance.txt'] as { content: string }).content =
      'mutated-instance';
    (manifestInit.entries['init.txt'] as { content: string }).content =
      'mutated-init';

    expect(normalizedInstance.manifest).toBe(manifestInstance);
    expect(normalizedInit.manifest).toBeInstanceOf(Manifest);
    expect(
      (
        normalizedInstance.manifest.entries['instance.txt'] as {
          content: string;
        }
      ).content,
    ).toBe('mutated-instance');
    expect(
      (normalizedInit.manifest.entries['init.txt'] as { content: string })
        .content,
    ).toBe('init');
  });

  it('passes object RunConfig model overrides into sandbox capability sampling', async () => {
    const client = new FakeSandboxClient();
    const samplingRecorder = new SamplingRecorderCapability();
    const runConfigModel = Object.assign(
      new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      { model: 'gpt-5-mini' },
    ) satisfies Model;
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      capabilities: [samplingRecorder],
    });
    const runner = new Runner({
      model: runConfigModel,
      sandbox: {
        client,
      },
    });

    const result = await runner.run(sandboxAgent, 'Hello');

    expect(result.finalOutput).toBe('sandbox done');
    expect(samplingRecorder.calls[0]).toMatchObject({
      model: 'gpt-5-mini',
      modelInstance: runConfigModel,
    });
  });

  it('passes string RunConfig model names into sandbox capability sampling', async () => {
    const client = new FakeSandboxClient();
    const samplingRecorder = new SamplingRecorderCapability();
    const runConfigModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      capabilities: [samplingRecorder],
    });
    const runner = new Runner({
      model: 'gpt-4o',
      modelProvider: {
        getModel: async (modelName?: string) => {
          expect(modelName).toBe('gpt-4o');
          return runConfigModel;
        },
      },
      sandbox: {
        client,
      },
    });

    const result = await runner.run(sandboxAgent, 'Hello');

    expect(result.finalOutput).toBe('sandbox done');
    expect(samplingRecorder.calls[0]).toMatchObject({
      model: 'gpt-4o',
      modelInstance: runConfigModel,
    });
  });

  it('resolves string RunConfig models before adding default sandbox tools', async () => {
    const client = new FakeSandboxClient();
    const chatModel = new OpenAIChatCompletionsModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const runner = new Runner({
      model: 'chat-model',
      modelProvider: {
        getModel: async (modelName?: string) => {
          expect(modelName).toBe('chat-model');
          return chatModel;
        },
      },
      sandbox: {
        client,
      },
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
    });

    const result = await runner.run(sandboxAgent, 'Hello');
    const toolsByName = new Map(
      chatModel.requests[0]?.tools.map((tool) => [tool.name, tool.type]),
    );

    expect(result.finalOutput).toBe('sandbox done');
    expect(toolsByName.get('exec_command')).toBe('function');
    expect(toolsByName.get('view_image')).toBe('function');
    expect(toolsByName.get('apply_patch')).toBe('function');
  });

  it('preserves resolved model instances for string sandbox agent models', async () => {
    const client = new FakeSandboxClient();
    const responsesModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const runner = new Runner({
      modelProvider: {
        getModel: async (modelName?: string) => {
          expect(modelName).toBe('gpt-5.4-mini');
          return responsesModel;
        },
      },
      sandbox: {
        client,
      },
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: 'gpt-5.4-mini',
    });

    const result = await runner.run(sandboxAgent, 'Hello');
    const toolNames = responsesModel.requests[0]?.tools.map(
      (tool) => tool.name,
    );

    expect(result.finalOutput).toBe('sandbox done');
    expect(toolNames).toContain('view_image');
    expect(toolNames).toContain('apply_patch');
  });

  it('uses the sandbox agent model before runner defaults for capability sampling', async () => {
    const client = new FakeSandboxClient();
    const samplingRecorder = new SamplingRecorderCapability();
    const runConfigModel = Object.assign(new RecordingFakeModel([]), {
      model: 'runner-model',
    }) satisfies Model;
    const agentModel = Object.assign(
      new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      { model: 'agent-model' },
    ) satisfies Model;
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: agentModel,
      capabilities: [samplingRecorder],
    });
    const runner = new Runner({
      model: runConfigModel,
      sandbox: {
        client,
      },
    });

    const result = await runner.run(sandboxAgent, 'Hello');

    expect(result.finalOutput).toBe('sandbox done');
    expect(samplingRecorder.calls[0]).toMatchObject({
      model: 'agent-model',
      modelInstance: agentModel,
    });
    expect((runConfigModel as RecordingFakeModel).requests).toHaveLength(0);
  });

  it('processes capability manifests before creating sandbox sessions', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      capabilities: [
        filesystem(),
        shell(),
        skills({
          skills: [
            {
              name: 'reviewer',
              description: 'reviews workspaces',
              content: 'Use this skill.',
            },
          ],
        }),
      ],
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]?.manifest.entries).toHaveProperty(
      '.agents/reviewer',
    );
  });

  it('propagates per-run sandbox config into sandbox agents used as tools', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('nested sandbox done')],
          usage: new Usage(),
        },
      ]),
      capabilities: [],
    });
    const outerAgent = new Agent({
      name: 'OuterAgent',
      model: new RecordingFakeModel([
        {
          output: [
            {
              id: 'call-1',
              type: 'function_call',
              name: 'sandbox_worker',
              callId: 'call-1',
              status: 'completed',
              arguments: '{"input":"run nested sandbox"}',
            } as any,
          ],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('outer done')],
          usage: new Usage(),
        },
      ]),
      tools: [
        sandboxAgent.asTool({
          toolName: 'sandbox_worker',
          toolDescription: 'Run the sandbox worker.',
        }),
      ],
    });

    const result = await new Runner().run(outerAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.finalOutput).toBe('outer done');
    expect(client.createCalls).toHaveLength(1);
  });

  it('applies agent manifests to provided live sessions', async () => {
    const liveSessionState: FakeSandboxSessionState = {
      manifest: new Manifest({
        root: '/workspace',
      }),
      sessionId: 'live-session',
    };
    const client = new FakeSandboxClient();
    const liveSession = client.makeSession(liveSessionState);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({
        entries: {
          'seed.txt': {
            type: 'file',
            content: 'seed\n',
          },
        },
      }),
      capabilities: [
        filesystem(),
        shell(),
        skills({
          skills: [
            {
              name: 'reviewer',
              description: 'reviews workspaces',
              content: 'Use this skill.',
            },
          ],
        }),
      ],
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
        session: liveSession,
      },
    });

    expect(liveSessionState.manifest.entries).toHaveProperty('seed.txt');
    expect(liveSessionState.manifest.entries).toHaveProperty(
      '.agents/reviewer',
    );
    expect(client.closeCalls).toEqual([]);
  });

  it('rebuilds prepared sandbox agents when the session manifest changes', async () => {
    const client = new FakeSandboxClient();
    const liveSession = client.makeSession({
      manifest: new Manifest({
        root: '/workspace',
        entries: {
          'seed.txt': {
            type: 'file',
            content: 'seed\n',
          },
        },
      }),
      sessionId: 'live-session',
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      capabilities: [],
    });
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
        session: liveSession,
      },
    });

    const { first, firstPrompt } = await withTrace(
      'manifest cache first prepare',
      async () => {
        const prepared = await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
        return {
          first: prepared,
          firstPrompt: await prepared.executionAgent.getSystemPrompt(
            new RunContext(),
          ),
        };
      },
    );

    liveSession.state.manifest = new Manifest({
      root: '/workspace',
      entries: {
        ...liveSession.state.manifest.entries,
        'loaded.txt': {
          type: 'file',
          content: 'loaded\n',
        },
      },
    });

    const { second, secondPrompt } = await withTrace(
      'manifest cache second prepare',
      async () => {
        const prepared = await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
        return {
          second: prepared,
          secondPrompt: await prepared.executionAgent.getSystemPrompt(
            new RunContext(),
          ),
        };
      },
    );

    expect(first.executionAgent).not.toBe(second.executionAgent);
    expect(firstPrompt).toContain('seed.txt');
    expect(firstPrompt).not.toContain('loaded.txt');
    expect(secondPrompt).toContain('loaded.txt');
  });

  it('preserves provided session manifest metadata when applying entries', async () => {
    const liveSessionState: FakeSandboxSessionState = {
      manifest: new Manifest({
        root: '/workspace',
        users: [{ name: 'sandbox-user' }],
        groups: [{ name: 'sandbox-group', users: [{ name: 'sandbox-user' }] }],
        extraPathGrants: [{ path: '/tmp/data', readOnly: true }],
        remoteMountCommandAllowlist: ['cat'],
      }),
      sessionId: 'live-session',
    };
    const client = new FakeSandboxClient();
    const liveSession = client.makeSession(liveSessionState);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({
        entries: {
          'seed.txt': {
            type: 'file',
            content: 'seed\n',
          },
        },
      }),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
        session: liveSession,
      },
    });

    expect(liveSessionState.manifest.entries).toHaveProperty('seed.txt');
    expect(liveSessionState.manifest.users).toEqual([{ name: 'sandbox-user' }]);
    expect(liveSessionState.manifest.groups).toEqual([
      { name: 'sandbox-group', users: [{ name: 'sandbox-user' }] },
    ]);
    expect(liveSessionState.manifest.extraPathGrants).toEqual([
      { path: '/tmp/data', readOnly: true },
    ]);
    expect(liveSessionState.manifest.remoteMountCommandAllowlist).toEqual([
      'cat',
    ]);
  });

  it('passes run-level snapshot and resource settings through sandbox client options', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
        snapshot: {
          type: 'local',
        },
        concurrencyLimits: {
          manifestEntries: 2,
          localDirFiles: 3,
        },
        archiveLimits: {
          maxInputBytes: 4,
          maxExtractedBytes: 5,
          maxMembers: 6,
        },
      },
    });

    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]?.snapshot).toEqual({
      type: 'local',
    });
    expect(client.createCalls[0]?.concurrencyLimits).toMatchObject({
      manifestEntries: 2,
      localDirFiles: 3,
    });
    expect(client.createCalls[0]?.archiveLimits).toMatchObject({
      maxInputBytes: 4,
      maxExtractedBytes: 5,
      maxMembers: 6,
    });
  });

  it('injects a default local snapshot only for clients that opt in', async () => {
    const defaultSnapshotClient = new DefaultSnapshotFakeSandboxClient();
    const plainClient = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('sandbox done again')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client: defaultSnapshotClient,
      },
    });
    await run(sandboxAgent, 'Hello again', {
      sandbox: {
        client: plainClient,
      },
    });

    expect(defaultSnapshotClient.createCalls[0]?.snapshot).toEqual({
      type: 'local',
    });
    expect(plainClient.createCalls[0]?.snapshot).toBeUndefined();
  });

  it('does not replace an explicit snapshot for default snapshot clients', async () => {
    const client = new DefaultSnapshotFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
        snapshot: {
          type: 'noop',
        },
      },
    });

    expect(client.createCalls[0]?.snapshot).toEqual({
      type: 'noop',
    });
  });

  it('injects runAs users into created session manifests', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({ root: '/workspace' }),
      runAs: { name: ' sandbox-user ' },
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]?.manifest.users).toEqual([
      { name: 'sandbox-user' },
    ]);
  });

  it('serializes sandbox session state and resumes it on the next run', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('turn one')],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('turn two')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();

    const firstResult = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(firstResult.finalOutput).toBe('turn one');
    expect(firstResult.state._sandbox).toMatchObject({
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: {
        version: SANDBOX_SESSION_STATE_VERSION,
        backendId: 'fake-sandbox',
        workspaceReady: true,
        providerState: {
          sessionId: 'session-1',
        },
      },
      sessionsByAgent: {
        SandboxWorker: {
          currentAgentName: 'SandboxWorker',
          sessionState: {
            providerState: {
              sessionId: 'session-1',
            },
          },
        },
      },
    });
    expect(client.createCalls).toHaveLength(1);
    expect(client.serializedOptions).toEqual([
      {
        preserveOwnedSession: false,
        reuseLiveSession: true,
        willCloseAfterSerialize: true,
      },
    ]);

    const resumedState = await RunState.fromString(
      sandboxAgent,
      firstResult.state.toString(),
    );
    resumedState._currentStep = undefined;
    const secondResult = await runner.run(sandboxAgent, resumedState, {
      sandbox: {
        client,
        archiveLimits: {
          maxInputBytes: 10,
          maxExtractedBytes: 20,
          maxMembers: 30,
        },
      },
    });

    expect(secondResult.finalOutput).toBe('turn two');
    expect(client.createCalls).toHaveLength(1);
    expect(client.resumeCalls).toMatchObject([
      {
        archiveLimits: {
          maxInputBytes: 10,
          maxExtractedBytes: 20,
          maxMembers: 30,
        },
      },
    ]);
  });

  it('sanitizes manifest data in serialized sandbox state envelopes', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
          'tmp.txt': {
            type: 'file',
            content: 'tmp\n',
            ephemeral: true,
          },
          dir: {
            type: 'dir',
            children: {
              'nested.tmp': {
                type: 'file',
                content: 'nested\n',
                ephemeral: true,
              },
            },
          },
          mounted: {
            type: 's3_mount',
            bucket: 'bucket',
          },
        },
        environment: {
          KEEP_ENV: 'keep',
          SECRET_ENV: {
            value: 'secret',
            ephemeral: true,
          },
        },
      }),
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });
    const manifest = result.state._sandbox?.sessionState.manifest as {
      entries: Record<string, any>;
      environment: Record<string, unknown>;
    };

    expect(manifest.entries).toHaveProperty('keep.txt');
    expect(manifest.entries).toHaveProperty('dir');
    expect(manifest.entries).toHaveProperty('mounted');
    expect(manifest.entries.mounted).toMatchObject({
      type: 's3_mount',
      bucket: 'bucket',
      ephemeral: true,
    });
    expect(manifest.entries).not.toHaveProperty('tmp.txt');
    expect(manifest.entries.dir.children).not.toHaveProperty('nested.tmp');
    expect(manifest.environment).toEqual({
      KEEP_ENV: {
        value: 'keep',
      },
    });
    expect(result.state.toString()).not.toContain('secret');
    expect(result.state.toString()).not.toContain('tmp\\n');
    expect(result.state.toString()).not.toContain('nested\\n');
  });

  it('does not serialize runtime environment overrides in sandbox state envelopes', async () => {
    class RuntimeEnvironmentFakeSandboxClient extends FakeSandboxClient {
      override async serializeSessionState(
        state: FakeSandboxSessionState,
      ): Promise<Record<string, unknown>> {
        state.environment = {
          KEEP_ENV: 'runtime-keep',
          RUNTIME_ENV: 'runtime-only',
          SECRET_ENV: 'runtime-secret',
        };
        return await super.serializeSessionState(state);
      }
    }

    const client = new RuntimeEnvironmentFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
      defaultManifest: new Manifest({
        environment: {
          KEEP_ENV: 'manifest-default',
          SECRET_ENV: {
            value: 'secret-default',
            ephemeral: true,
          },
        },
      }),
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });
    const manifest = result.state._sandbox?.sessionState.manifest as {
      environment: Record<string, unknown>;
    };

    expect(manifest.environment).toEqual({
      KEEP_ENV: {
        value: 'manifest-default',
      },
    });
    expect(result.state.toString()).not.toContain('runtime-keep');
    expect(result.state.toString()).not.toContain('runtime-only');
    expect(result.state.toString()).not.toContain('runtime-secret');
    expect(result.state.toString()).not.toContain('secret-default');
  });

  it('restores interrupted processed responses with sandbox-injected tools', async () => {
    const client = new FakeSandboxClient();
    let approvedToolCalls = 0;
    const needsApprovalTool = tool({
      name: 'needs_approval',
      description: 'Needs approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => {
        approvedToolCalls += 1;
        return 'approved';
      },
    });
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            type: 'function_call',
            id: 'fc_exec',
            callId: 'call_exec',
            name: 'exec_command',
            status: 'completed',
            arguments: '{"cmd":"echo hi"}',
          } satisfies protocol.FunctionCallItem,
          {
            type: 'function_call',
            id: 'fc_approval',
            callId: 'call_approval',
            name: 'needs_approval',
            status: 'completed',
            arguments: '{}',
          } satisfies protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      tools: [needsApprovalTool],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();

    const firstResult = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(firstResult.interruptions).toHaveLength(1);
    expect(client.execCommandCalls).toHaveLength(1);

    const resumedState = await RunState.fromString(
      sandboxAgent,
      firstResult.state.toString(),
    );
    const [approval] = resumedState.getInterruptions();
    expect(approval?.toolName).toBe('needs_approval');
    resumedState.approve(approval!);

    const secondResult = await runner.run(sandboxAgent, resumedState, {
      sandbox: {
        client,
      },
    });

    expect(secondResult.finalOutput).toBe('done');
    expect(client.execCommandCalls).toHaveLength(1);
    expect(approvedToolCalls).toBe(1);
  });

  it('rejects serialized sandbox state when the client cannot resume', async () => {
    const client = new FakeSandboxClient();
    Object.defineProperty(client, 'resume', {
      value: undefined,
    });
    const sandboxModel = new RecordingFakeModel([]);
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, SandboxAgent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'persisted',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'persisted',
          }),
        },
      },
    };

    await expect(
      new Runner().run(sandboxAgent, state, {
        sandbox: {
          client,
        },
      }),
    ).rejects.toThrow(
      'Sandbox client must implement resume() to restore sandbox session state.',
    );
    expect(client.createCalls).toHaveLength(0);
  });

  it('rejects unsupported serialized sandbox session state versions', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([]);
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, SandboxAgent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    const sessionState = fakeSandboxSessionStateEnvelope(
      {
        root: '/workspace',
        sessionId: 'persisted',
      },
      { version: 999 },
    ) as any;
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState,
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          sessionState,
        },
      },
    };

    await expect(
      new Runner().run(sandboxAgent, state, {
        sandbox: {
          client,
        },
      }),
    ).rejects.toThrow(
      'Sandbox session state version 999 is not supported. Please use version 1.',
    );
    expect(client.createCalls).toHaveLength(0);
    expect(client.resumeCalls).toHaveLength(0);
  });

  it('passes SDK envelope fields to provider-owned sandbox session deserializers', async () => {
    const client = new FakeSandboxClient();
    const deserializedStates: Record<string, unknown>[] = [];
    client.deserializeSessionState = async (state) => {
      deserializedStates.push(state);
      return {
        manifest: new Manifest({
          root: String((state.manifest as { root?: unknown }).root),
        }),
        sessionId: String(state.sessionId),
        snapshot: state.snapshot as FakeSandboxSessionState['snapshot'],
        snapshotFingerprint:
          state.snapshotFingerprint as FakeSandboxSessionState['snapshotFingerprint'],
        snapshotFingerprintVersion:
          state.snapshotFingerprintVersion as FakeSandboxSessionState['snapshotFingerprintVersion'],
        workspaceReady: state.workspaceReady as boolean,
        exposedPorts:
          state.exposedPorts as FakeSandboxSessionState['exposedPorts'],
      };
    };

    const state = await deserializeSandboxSessionStateEntry(client, {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope(
        {
          sessionId: 'persisted',
        },
        {
          manifest: {
            version: 1,
            root: '/workspace',
            entries: {
              'README.md': { type: 'file', content: 'hello\n' },
            },
            environment: {},
          },
          snapshot: { provider: 'snapshot' },
          snapshotFingerprint: 'fingerprint',
          snapshotFingerprintVersion: '2',
          workspaceReady: false,
          exposedPorts: {
            '3000': { host: '127.0.0.1', port: 3000 },
          },
        },
      ),
    });

    expect(deserializedStates[0]).toMatchObject({
      sessionId: 'persisted',
      manifest: {
        root: '/workspace',
        entries: {
          'README.md': { type: 'file', content: 'hello\n' },
        },
      },
      snapshot: { provider: 'snapshot' },
      snapshotFingerprint: 'fingerprint',
      snapshotFingerprintVersion: '2',
      workspaceReady: false,
      exposedPorts: {
        '3000': { host: '127.0.0.1', port: 3000 },
      },
    });
    expect(state?.workspaceReady).toBe(false);
    expect(state?.exposedPorts).toEqual({
      '3000': { host: '127.0.0.1', port: 3000 },
    });
  });

  it('resets required tool choice after a sandbox agent uses a tool', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'tool-1',
            type: 'function_call',
            name: 'exec_command',
            callId: 'tool-1',
            status: 'completed',
            arguments: JSON.stringify({ cmd: 'pwd' }),
          },
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      modelSettings: {
        toolChoice: 'required',
      },
      defaultManifest: new Manifest({ root: '/workspace' }),
      capabilities: [shell()],
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.finalOutput).toBe('sandbox done');
    expect(sandboxModel.requests[0]?.modelSettings.toolChoice).toBe('required');
    expect(sandboxModel.requests[1]?.modelSettings.toolChoice).toBeUndefined();
  });

  it('resets required tool choice after a sandbox agent uses a shell tool', async () => {
    const client = new FakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'shell-1',
            type: 'shell_call',
            callId: 'shell-1',
            status: 'completed',
            action: {
              commands: ['pwd'],
            },
          },
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      modelSettings: {
        toolChoice: 'required',
      },
      defaultManifest: new Manifest({ root: '/workspace' }),
      capabilities: [new ShellToolCapability()],
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.finalOutput).toBe('sandbox done');
    expect(sandboxModel.requests[0]?.modelSettings.toolChoice).toBe('required');
    expect(sandboxModel.requests[1]?.modelSettings.toolChoice).toBeUndefined();
  });

  it('allows reserved function tool names returned from sandbox capabilities', async () => {
    const sandboxModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      defaultManifest: new Manifest({ root: '/workspace' }),
      capabilities: [new ReservedFunctionNameCapability()],
    });

    const result = await run(sandboxAgent, 'Hello', {
      sandbox: {
        client: new FakeSandboxClient(),
      },
    });

    const toolsByName = new Map(
      sandboxModel.requests[0]?.tools.map((tool) => [tool.name, tool.type]),
    );

    expect(result.finalOutput).toBe('sandbox done');
    expect(toolsByName.get('shell')).toBe('function');
  });

  it('uses the public sandbox agent for filters, hooks, and run items', async () => {
    const client = new FakeSandboxClient();
    const seenFilterAgents: unknown[] = [];
    const runnerStartAgents: unknown[] = [];
    const runnerEndAgents: unknown[] = [];
    const runnerToolStartAgents: unknown[] = [];
    const runnerToolEndAgents: unknown[] = [];
    const agentStartAgents: unknown[] = [];
    let agentToolStarts = 0;
    let agentToolEnds = 0;
    const sandboxTool = tool({
      name: 'sandbox_tool',
      description: 'Sandbox tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'tool result',
    });
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'fc_sandbox_tool',
            type: 'function_call',
            name: 'sandbox_tool',
            callId: 'call_sandbox_tool',
            status: 'completed',
            arguments: '{}',
          } satisfies protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      tools: [sandboxTool],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();
    runner.on('agent_start', (_context, agent) => {
      runnerStartAgents.push(agent);
    });
    runner.on('agent_end', (_context, agent) => {
      runnerEndAgents.push(agent);
    });
    runner.on('agent_tool_start', (_context, agent) => {
      runnerToolStartAgents.push(agent);
    });
    runner.on('agent_tool_end', (_context, agent) => {
      runnerToolEndAgents.push(agent);
    });
    sandboxAgent.on('agent_start', (_context, agent) => {
      agentStartAgents.push(agent);
    });
    sandboxAgent.on('agent_tool_start', () => {
      agentToolStarts += 1;
    });
    sandboxAgent.on('agent_tool_end', () => {
      agentToolEnds += 1;
    });

    const result = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
      callModelInputFilter: ({ agent, modelData }) => {
        seenFilterAgents.push(agent);
        return modelData;
      },
    });

    expect(result.finalOutput).toBe('sandbox done');
    expect(seenFilterAgents).toEqual([sandboxAgent, sandboxAgent]);
    expect(runnerStartAgents).toEqual([sandboxAgent]);
    expect(runnerEndAgents).toEqual([sandboxAgent]);
    expect(runnerToolStartAgents).toEqual([sandboxAgent]);
    expect(runnerToolEndAgents).toEqual([sandboxAgent]);
    expect(agentStartAgents).toEqual([sandboxAgent]);
    expect(agentToolStarts).toBe(1);
    expect(agentToolEnds).toBe(1);
    expect(result.lastAgent).toBe(sandboxAgent);
    expect(result.newItems.length).toBeGreaterThan(0);
    const resultItemsWithAgents = result.newItems.filter(
      (item): item is typeof item & { agent: unknown } => 'agent' in item,
    );
    expect(resultItemsWithAgents).toHaveLength(result.newItems.length);
    expect(
      resultItemsWithAgents.every((item) => item.agent === sandboxAgent),
    ).toBe(true);
  });

  it('uses the public sandbox agent for streamed filters and item events', async () => {
    const client = new FakeSandboxClient();
    const seenFilterAgents: unknown[] = [];
    const sandboxTool = tool({
      name: 'sandbox_tool',
      description: 'Sandbox tool.',
      parameters: z.object({}).strict(),
      execute: async () => 'tool result',
    });
    const sandboxModel = new RecordingStreamingModel([
      {
        output: [
          {
            type: 'reasoning',
            id: 'rs_sandbox',
            content: [{ type: 'input_text', text: 'reasoning trace' }],
          } satisfies protocol.ReasoningItem,
          {
            id: 'fc_sandbox_tool',
            type: 'function_call',
            name: 'sandbox_tool',
            callId: 'call_sandbox_tool',
            status: 'completed',
            arguments: '{}',
          } satisfies protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('streamed sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'StreamedSandboxWorker',
      model: sandboxModel,
      tools: [sandboxTool],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });

    const result = await run(sandboxAgent, 'Hello', {
      stream: true,
      sandbox: {
        client,
      },
      callModelInputFilter: ({ agent, modelData }) => {
        seenFilterAgents.push(agent);
        return modelData;
      },
    });
    const events = [];
    for await (const event of result.toStream()) {
      events.push(event);
    }
    await result.completed;
    const itemEvents = events.filter(
      (event): event is RunItemStreamEvent =>
        event instanceof RunItemStreamEvent,
    );

    expect(result.finalOutput).toBe('streamed sandbox done');
    expect(result.currentAgent).toBe(sandboxAgent);
    expect(seenFilterAgents).toEqual([sandboxAgent, sandboxAgent]);
    expect(itemEvents.length).toBeGreaterThan(0);
    const itemEventsWithAgents = itemEvents.filter(
      (event): event is RunItemStreamEvent & { item: { agent: unknown } } =>
        'agent' in event.item,
    );
    expect(itemEventsWithAgents).toHaveLength(itemEvents.length);
    expect(
      itemEventsWithAgents.every((event) => event.item.agent === sandboxAgent),
    ).toBe(true);
  });

  it('clears prior sandbox state when a resumed turn does not touch sandbox agents', async () => {
    const agent = new Agent<unknown, any>({ name: 'PlainAgent' });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      agent,
      1,
    );
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        sessionId: 'persisted',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          sessionState: fakeSandboxSessionStateEnvelope({
            sessionId: 'persisted',
          }),
        },
      },
    };
    const client = new FakeSandboxClient();

    const manager = new SandboxRuntimeManager({
      startingAgent: agent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await manager.cleanup(state);

    expect(state._sandbox).toBeUndefined();
    expect(client.createCalls).toHaveLength(0);
    expect(client.resumeCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual([]);
  });

  it('resets the current tracing span when final sandbox cleanup fails', async () => {
    setTracingDisabled(false);
    const agent = new Agent<unknown, any>({ name: 'PlainAgent' });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      agent,
      1,
    );
    const cleanupError = new Error('cleanup failed');
    const sandboxRuntime = {
      enqueueMemoryGeneration: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn().mockRejectedValue(cleanupError),
    } as unknown as SandboxRuntimeManager<unknown>;

    await withTrace('Sandbox cleanup failure trace reset test', async () => {
      const span = createAgentSpan({ data: { name: 'PlainAgent' } });
      state._currentAgentSpan = span;
      setCurrentSpan(span);

      expect(getCurrentSpan()).toBe(span);
      await expect(
        finalizeSandboxRuntime({
          state,
          sandboxRuntime,
          preserveSessionsForInterruption: false,
          runAgent: async () => ({ finalOutput: undefined }),
        }),
      ).rejects.toBe(cleanupError);
      expect(getCurrentSpan()).toBeNull();
    });

    expect(sandboxRuntime.cleanup).toHaveBeenCalledOnce();
  });

  it('preserves serialized sessions for sandbox agents untouched by a resumed run', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'sandbox-worker-old',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'sandbox-worker-old',
          }),
        },
        OtherWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'OtherWorker',
          currentAgentName: 'OtherWorker',
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'other-worker-old',
          }),
        },
      },
    };

    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('Sandbox state preservation test', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent,
        turnInput: [],
      });
      await manager.cleanup(state);
    });

    expect(client.resumeCalls.map((call) => call.state.sessionId)).toEqual([
      'sandbox-worker-old',
    ]);
    expect(state._sandbox).toMatchObject({
      currentAgentKey: 'SandboxWorker',
      sessionsByAgent: {
        SandboxWorker: {
          sessionState: {
            providerState: {
              sessionId: 'sandbox-worker-old',
            },
          },
        },
        OtherWorker: {
          sessionState: {
            providerState: {
              sessionId: 'other-worker-old',
            },
          },
        },
      },
    });
  });

  it('emits sandbox lifecycle custom spans during a traced run', async () => {
    const processor = new RecordingTracingProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(false);

    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await withTrace('Sandbox trace test', async () => {
      await run(sandboxAgent, 'Hello', {
        sandbox: {
          client: new FakeSandboxClient(),
        },
      });
    });

    const customSpanNames = processor.spansEnded
      .filter((span) => span.spanData.type === 'custom')
      .map((span) => span.spanData.name);

    expect(customSpanNames).toEqual(
      expect.arrayContaining([
        'sandbox.prepare_agent',
        'sandbox.create_session',
        'sandbox.cleanup',
        'sandbox.cleanup_sessions',
        'sandbox.shutdown',
      ]),
    );
  });

  it('rejects concurrent reuse of the same SandboxAgent across runs', async () => {
    let releaseFirstRun: (() => void) | undefined;
    const blockingModel = {
      async getResponse(request: ModelRequest) {
        await new Promise<void>((resolve) => {
          releaseFirstRun = resolve;
        });
        return {
          output: [
            fakeModelMessage(String(request.systemInstructions ?? 'done')),
          ],
          usage: new Usage(),
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: blockingModel,
    });
    const runner = new Runner();
    const client = new FakeSandboxClient();

    const firstRun = runner.run(sandboxAgent, 'first', {
      sandbox: { client },
    });
    while (!releaseFirstRun) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(
      runner.run(sandboxAgent, 'second', {
        sandbox: { client },
      }),
    ).rejects.toThrow(
      "SandboxAgent 'SandboxWorker' cannot be reused concurrently across runs",
    );

    releaseFirstRun?.();
    await firstRun;
  });

  it('closes owned sandbox sessions during cleanup', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.closeCalls).toEqual(['session-1']);
  });

  it('closes a shared owned sandbox session once during cleanup', async () => {
    const client = new FakeSandboxClient();
    const sharedSession = client.makeSession({
      manifest: new Manifest(),
      sessionId: 'shared-session',
    });
    const firstAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const secondAgent = new SandboxAgent({
      name: 'SandboxReviewer',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      firstAgent as Agent<unknown, any>,
      1,
    );
    const manager = new SandboxRuntimeManager({
      startingAgent: firstAgent as Agent<unknown, any>,
      runState: state,
    });
    const managerInternals = manager as unknown as {
      sessionsByAgentKey: Map<string, SandboxSessionLike>;
      sessionAgentNamesByKey: Map<string, string>;
      ownedSessionAgentKeys: Set<string>;
    };

    managerInternals.sessionsByAgentKey.set('SandboxWorker', sharedSession);
    managerInternals.sessionsByAgentKey.set('SandboxReviewer', sharedSession);
    managerInternals.sessionAgentNamesByKey.set(
      'SandboxWorker',
      firstAgent.name,
    );
    managerInternals.sessionAgentNamesByKey.set(
      'SandboxReviewer',
      secondAgent.name,
    );
    managerInternals.ownedSessionAgentKeys.add('SandboxWorker');
    managerInternals.ownedSessionAgentKeys.add('SandboxReviewer');

    await withTrace('shared owned session close test', async () => {
      await manager.cleanup(state);
    });

    expect(client.closeCalls).toEqual(['shared-session']);
  });

  it('starts owned sandbox sessions before agent execution', async () => {
    const client = new StartableFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.startCalls).toEqual([
      {
        sessionId: 'session-1',
        reason: 'create',
      },
    ]);
  });

  it('starts adopted preserved sandbox sessions before agent execution', async () => {
    const client = new StartableFakeSandboxClient();
    const archiveLimits = {
      maxInputBytes: 10,
      maxExtractedBytes: 20,
      maxMembers: 30,
    };
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'resumed-session',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'resumed-session',
          }),
        },
      },
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
        archiveLimits,
      },
      runState: state,
    });

    await withTrace('adopted preserved session start test', async () => {
      await manager.adoptPreservedOwnedSessions();
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await manager.cleanup(state);
    });

    expect(client.resumeCalls.map((call) => call.state.sessionId)).toEqual([
      'resumed-session',
    ]);
    expect(client.resumeCalls[0]?.archiveLimits).toEqual(archiveLimits);
    expect(client.startCalls).toEqual([
      {
        sessionId: 'resumed-session',
        reason: 'resume',
      },
    ]);
  });

  it('does not restart provided sandbox sessions that report running', async () => {
    const client = new StartableFakeSandboxClient();
    const providedSession = client.makeSession({
      manifest: new Manifest(),
      sessionId: 'provided-session',
    });
    await providedSession.start?.({ reason: 'test' });
    client.startCalls.length = 0;
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        session: providedSession,
      },
    });

    expect(client.startCalls).toEqual([]);
  });

  it('starts a shared provided sandbox session only once across agent keys', async () => {
    const client = new StartOnlyFakeSandboxClient();
    const providedSession = client.makeSession({
      manifest: new Manifest(),
      sessionId: 'provided-session',
    });
    const firstAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const secondAgent = new SandboxAgent({
      name: 'SandboxReviewer',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      firstAgent as Agent<unknown, any>,
      1,
    );
    const manager = new SandboxRuntimeManager({
      startingAgent: firstAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
      runState: state,
    });

    await withTrace('shared provided session start test', async () => {
      await manager.prepareAgent({
        currentAgent: firstAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await manager.prepareAgent({
        currentAgent: secondAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await manager.cleanup(state);
    });

    expect(client.startCalls).toEqual([
      {
        sessionId: 'provided-session',
        reason: 'provided',
      },
    ]);
  });

  it('allocates unique keys for runtime sandbox agents with duplicate names', async () => {
    const client = new FakeSandboxClient();
    const startingAgent = new Agent({
      name: 'Router',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const firstAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'RuntimeWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        entries: {
          'first.txt': {
            type: 'file',
            content: 'first\n',
          },
        },
      }),
    });
    const secondAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'RuntimeWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        entries: {
          'second.txt': {
            type: 'file',
            content: 'second\n',
          },
        },
      }),
    });
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      startingAgent,
      1,
    );
    const manager = new SandboxRuntimeManager({
      startingAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('runtime duplicate sandbox agent key test', async () => {
      await manager.prepareAgent({
        currentAgent: firstAgent,
        turnInput: [],
      });
      await manager.prepareAgent({
        currentAgent: secondAgent,
        turnInput: [],
      });
      await manager.cleanup(state, { preserveOwnedSessions: true });
    });

    expect(client.createCalls).toHaveLength(2);
    expect(client.createCalls[0]?.manifest.entries).toHaveProperty('first.txt');
    expect(client.createCalls[1]?.manifest.entries).toHaveProperty(
      'second.txt',
    );
    expect(Object.keys(state._sandbox?.sessionsByAgent ?? {})).toEqual([
      'RuntimeWorker',
      'RuntimeWorker_2',
    ]);
    expect(state._sandbox?.currentAgentKey).toBe('RuntimeWorker_2');
  });

  it('runs preStop without stopping provided sandbox sessions during cleanup', async () => {
    const client = new StandardLifecycleFakeSandboxClient();
    const providedSession = client.makeSession({
      manifest: new Manifest(),
      sessionId: 'provided-session',
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        session: providedSession,
      },
    });

    expect(client.lifecycleCalls).toEqual([
      {
        hook: 'preStop',
        sessionId: 'provided-session',
        reason: 'cleanup',
      },
    ]);
  });

  it('uses standardized shutdown hooks for owned sandbox cleanup', async () => {
    const client = new ShutdownOnlyFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.shutdownCalls).toEqual([
      {
        sessionId: 'session-1',
        reason: 'cleanup',
      },
    ]);
    expect(client.closeCalls).toEqual([]);
  });

  it('keeps lifecycle preStop when managed pre-stop hooks are installed', async () => {
    const calls: string[] = [];
    const session: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        manifest: new Manifest(),
        sessionId: 'session-1',
      },
      preStop: async (options) => {
        calls.push(`preStop:${options?.reason}`);
      },
      close: async () => {
        calls.push('close');
      },
    };

    registerSandboxPreStopHook(session, () => {
      calls.push('hook');
    });

    await cleanupSandboxSession(session);

    expect(calls).toEqual(['hook', 'preStop:cleanup', 'close']);
  });

  it('passes preserveOwnedSessions through standardized lifecycle cleanup', async () => {
    const calls: unknown[] = [];
    const session: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        manifest: new Manifest(),
        sessionId: 'session-1',
      },
      shutdown: async (options) => {
        calls.push(options);
      },
    };

    await cleanupSandboxSession(session, { preserveOwnedSessions: true });

    expect(calls).toEqual([
      {
        reason: 'cleanup',
        preserveOwnedSessions: true,
      },
    ]);
  });

  it('runs managed provider pre-stop hooks before serialization', async () => {
    const calls: string[] = [];
    const providerHooks = new Set<() => Promise<void> | void>();
    const session: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        manifest: new Manifest(),
        sessionId: 'session-1',
      },
      registerPreStopHook: (hook) => {
        providerHooks.add(hook);
        return () => {
          providerHooks.delete(hook);
        };
      },
    };

    const unregister = registerSandboxPreStopHook(session, () => {
      calls.push('hook');
    });

    await runSandboxSessionPreStopHooks(session);
    expect(calls).toEqual(['hook']);

    calls.length = 0;
    for (const hook of providerHooks) {
      await hook();
    }
    expect(calls).toEqual([]);

    unregister();
    expect(providerHooks.size).toBe(0);
  });

  it('cleans up sessions that only expose provider pre-stop hooks', async () => {
    const calls: string[] = [];
    const providerHooks = new Set<() => Promise<void> | void>();
    const session: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        manifest: new Manifest(),
        sessionId: 'session-1',
      },
      registerPreStopHook: (hook) => {
        providerHooks.add(hook);
        return () => {
          providerHooks.delete(hook);
        };
      },
    };

    registerSandboxPreStopHook(session, () => {
      calls.push('hook');
    });

    await cleanupSandboxSession(session);

    expect(calls).toEqual(['hook']);
  });

  it('runs standardized lifecycle cleanup hooks in order', async () => {
    const client = new StandardLifecycleFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(client.lifecycleCalls).toEqual([
      {
        hook: 'preStop',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'stop',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'shutdown',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'delete',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
    ]);
    expect(client.closeCalls).toEqual([]);
  });

  it('continues lifecycle cleanup after an earlier hook fails', async () => {
    const client = new FailingStopLifecycleFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await expect(
      run(sandboxAgent, 'Hello', {
        sandbox: {
          client,
        },
      }),
    ).rejects.toThrow('stop failed');

    expect(client.lifecycleCalls).toEqual([
      {
        hook: 'preStop',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'stop',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'shutdown',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
      {
        hook: 'delete',
        sessionId: 'session-1',
        reason: 'cleanup',
      },
    ]);
  });

  it('closes owned sandbox sessions when serialization fails during cleanup', async () => {
    const client = new FakeSandboxClient();
    vi.spyOn(client, 'serializeSessionState').mockRejectedValue(
      new Error('snapshot failed'),
    );
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [fakeModelMessage('sandbox done')],
          usage: new Usage(),
        },
      ]),
    });

    await expect(
      run(sandboxAgent, 'Hello', {
        sandbox: {
          client,
        },
      }),
    ).rejects.toThrow('snapshot failed');

    expect(client.closeCalls).toEqual(['session-1']);
  });

  it('keeps owned sandbox sessions alive across approval interruptions', async () => {
    const client = new NonPersistentFakeSandboxClient();
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'requires approval',
      parameters: z.object({}).strict(),
      execute: async () => 'approved',
      needsApproval: true,
    });
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'approval-1',
            type: 'function_call',
            name: 'needs_approval',
            callId: 'approval-1',
            status: 'completed',
            arguments: '{}',
          } as any,
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      tools: [approvalTool],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();

    const firstResult = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(firstResult.interruptions).toHaveLength(1);
    expect(firstResult.interruptions?.[0]?.agent).toBe(sandboxAgent);
    expect(firstResult.state._sandbox).toMatchObject({
      sessionsByAgent: {
        SandboxWorker: {
          currentAgentName: 'SandboxWorker',
        },
      },
    });
    expect(client.createCalls).toHaveLength(1);
    expect(client.closeCalls).toEqual([]);

    const approval = firstResult.interruptions?.[0];
    if (!approval) {
      throw new Error('Expected an approval interruption');
    }
    firstResult.state.approve(approval);

    const resumedResult = await runner.run(sandboxAgent, firstResult.state, {
      sandbox: {
        client,
      },
    });

    expect(resumedResult.finalOutput).toBe('sandbox done');
    expect(resumedResult.lastAgent).toBe(sandboxAgent);
    expect(client.createCalls).toHaveLength(1);
    expect(client.resumeCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual(['session-1']);
  });

  it('rebinds interrupted sandbox capability tools after resuming a closed preserved session', async () => {
    const client = new ClosedHandleSerializedResumeFakeSandboxClient();
    const sandboxModel = new RecordingFakeModel([
      {
        output: [
          {
            id: 'shell-approval-1',
            type: 'function_call',
            name: 'exec_command',
            callId: 'shell-approval-1',
            status: 'completed',
            arguments: '{"cmd":"echo hi"}',
          } satisfies protocol.FunctionCallItem,
        ],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('sandbox done')],
        usage: new Usage(),
      },
    ]);
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: sandboxModel,
      capabilities: [
        shell({
          configureTools: (tools) =>
            tools.map((capabilityTool) =>
              capabilityTool.type === 'function' &&
              capabilityTool.name === 'exec_command'
                ? { ...capabilityTool, needsApproval: async () => true }
                : capabilityTool,
            ),
        }),
      ],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();

    const firstResult = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(firstResult.interruptions).toHaveLength(1);
    expect(client.execCommandCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual(['session-1']);
    expect(
      firstResult.state._sandbox?.sessionsByAgent.SandboxWorker,
    ).toMatchObject({
      preservedOwnedSession: true,
      reuseLiveSession: false,
    });

    const approval = firstResult.interruptions?.[0];
    if (!approval) {
      throw new Error('Expected a shell approval interruption');
    }
    firstResult.state.approve(approval);

    const resumedResult = await runner.run(sandboxAgent, firstResult.state, {
      sandbox: {
        client,
      },
    });

    expect(resumedResult.finalOutput).toBe('sandbox done');
    expect(client.resumeCalls).toHaveLength(1);
    expect(client.execCommandCalls).toHaveLength(1);
    expect(client.closeCalls).toEqual(['session-1', 'session-1']);
  });

  it('reacquires preserved sessions when host approval completes the run', async () => {
    const client = new NonPersistentFakeSandboxClient();
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'requires approval',
      parameters: z.object({}).strict(),
      execute: async () => 'approved',
      needsApproval: true,
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [
            {
              id: 'approval-1',
              type: 'function_call',
              name: 'needs_approval',
              callId: 'approval-1',
              status: 'completed',
              arguments: '{}',
            } as any,
          ],
          usage: new Usage(),
        },
      ]),
      tools: [approvalTool],
      toolUseBehavior: 'stop_on_first_tool',
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const runner = new Runner();

    const firstResult = await runner.run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });
    const approval = firstResult.interruptions?.[0];
    if (!approval) {
      throw new Error('Expected an approval interruption');
    }
    firstResult.state.approve(approval);

    const resumedResult = await runner.run(sandboxAgent, firstResult.state, {
      sandbox: {
        client,
      },
    });

    expect(resumedResult.finalOutput).toBe('approved');
    expect(client.createCalls).toHaveLength(1);
    expect(client.resumeCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual(['session-1']);
    expect(resumedResult.state._sandbox).toBeUndefined();
  });

  it('clears preserved sandbox state for non-sandbox interruption resumes without a client', async () => {
    const plainAgent = new Agent({
      name: 'PlainAgent',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      plainAgent,
      1,
    );
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'sandbox-worker-old',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'sandbox-worker-old',
          }),
        },
      },
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: plainAgent,
      runState: state,
    });

    await expect(
      prepareSandboxInterruptedTurnResume({
        startingAgent: plainAgent,
        state,
        sandboxRuntime: manager,
      }),
    ).resolves.toBeUndefined();
    await manager.cleanup(state);

    expect(state._sandbox).toBeUndefined();
  });

  it('closes live preserved owned sessions on non-sandbox interruption cleanup', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const plainAgent = new Agent({
      name: 'PlainAgent',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await firstManager.prepareAgent({
      currentAgent: sandboxAgent,
      turnInput: [],
    });
    await firstManager.cleanup(state, { preserveOwnedSessions: true });
    expect(client.closeCalls).toEqual([]);

    state._currentAgent = plainAgent;
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;

    const secondManager = new SandboxRuntimeManager({
      startingAgent: plainAgent,
      runState: state,
    });

    await prepareSandboxInterruptedTurnResume({
      startingAgent: plainAgent,
      state,
      sandboxRuntime: secondManager,
    });
    await secondManager.cleanup(state);

    expect(client.closeCalls).toEqual(['session-1']);
    expect(state._sandbox).toBeUndefined();
  });

  it('continues closing live preserved owned sessions after a close failure', async () => {
    const client = new SelectiveCloseFailureFakeSandboxClient(
      new Set(['session-1']),
    );
    const firstSandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'FirstSandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const secondSandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SecondSandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const plainAgent = new Agent({
      name: 'PlainAgent',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      firstSandboxAgent,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: firstSandboxAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await firstManager.prepareAgent({
      currentAgent: firstSandboxAgent,
      turnInput: [],
    });
    await firstManager.prepareAgent({
      currentAgent: secondSandboxAgent,
      turnInput: [],
    });
    await firstManager.cleanup(state, { preserveOwnedSessions: true });

    state._currentAgent = plainAgent;
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;

    const secondManager = new SandboxRuntimeManager({
      startingAgent: plainAgent,
      runState: state,
    });

    await prepareSandboxInterruptedTurnResume({
      startingAgent: plainAgent,
      state,
      sandboxRuntime: secondManager,
    });
    await expect(secondManager.cleanup(state)).rejects.toThrow(
      'Failed to close session-1',
    );

    expect(client.closeAttempts).toEqual(['session-1', 'session-2']);
    expect(client.closeCalls).toEqual(['session-2']);
  });

  it('closes mixed live and restorable preserved sessions on non-sandbox interruption cleanup', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const plainAgent = new Agent({
      name: 'PlainAgent',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await firstManager.prepareAgent({
      currentAgent: sandboxAgent,
      turnInput: [],
    });
    await firstManager.cleanup(state, { preserveOwnedSessions: true });
    state._sandbox!.sessionsByAgent.OtherWorker = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'OtherWorker',
      currentAgentName: 'OtherWorker',
      preservedOwnedSession: true,
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'other-worker-old',
      }),
    };

    state._currentAgent = plainAgent;
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;

    const secondManager = new SandboxRuntimeManager({
      startingAgent: plainAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await prepareSandboxInterruptedTurnResume({
      startingAgent: plainAgent,
      state,
      sandboxRuntime: secondManager,
    });
    await secondManager.cleanup(state);

    expect(client.resumeCalls.map((call) => call.state.sessionId)).toEqual([
      'other-worker-old',
    ]);
    expect(client.closeCalls).toEqual(['session-1', 'other-worker-old']);
    expect(state._sandbox).toBeUndefined();
  });

  it('closes restorable preserved owned sessions on non-sandbox interruption cleanup', async () => {
    const client = new FakeSandboxClient();
    const plainAgent = new Agent({
      name: 'PlainAgent',
      model: new RecordingFakeModel([]),
    }) as Agent<unknown, AgentOutputType>;
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      plainAgent,
      1,
    );
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'sandbox-worker-old',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'sandbox-worker-old',
          }),
        },
      },
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: plainAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await prepareSandboxInterruptedTurnResume({
      startingAgent: plainAgent,
      state,
      sandboxRuntime: manager,
    });
    expect(client.resumeCalls).toHaveLength(0);

    await manager.cleanup(state);

    expect(client.resumeCalls.map((call) => call.state.sessionId)).toEqual([
      'sandbox-worker-old',
    ]);
    expect(client.closeCalls).toEqual(['sandbox-worker-old']);
    expect(state._sandbox).toBeUndefined();
  });

  it('preserves sandbox state when interruption resume setup cannot adopt preserved sessions', async () => {
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    const sandboxState = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'sandbox-worker-old',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'sandbox-worker-old',
          }),
        },
      },
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [] },
    };
    state._lastTurnResponse = {
      output: [],
      usage: new Usage(),
    };
    state._lastProcessedResponse = {
      newItems: [],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      handoffs: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
    } as any;
    state._sandbox = sandboxState;
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent,
      runState: state,
    });

    await expect(
      prepareSandboxInterruptedTurnResume({
        startingAgent: sandboxAgent,
        state,
        sandboxRuntime: manager,
      }),
    ).rejects.toThrow(
      'Sandbox client must be configured to restore preserved sandbox sessions.',
    );
    await manager.cleanup(state, { preserveOwnedSessions: true });

    expect(state._sandbox).toBe(sandboxState);
  });

  it('closes untouched preserved owned sessions after interruption resume', async () => {
    const client = new NonPersistentFakeSandboxClient();
    const sandboxAgent = new SandboxAgent<unknown, AgentOutputType>({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({ root: '/workspace' }),
    });
    const state = new RunState<unknown, Agent<unknown, AgentOutputType>>(
      new RunContext(),
      'Hello',
      sandboxAgent,
      1,
    );
    state._sandbox = {
      backendId: 'fake-sandbox',
      currentAgentKey: 'SandboxWorker',
      currentAgentName: 'SandboxWorker',
      sessionState: fakeSandboxSessionStateEnvelope({
        root: '/workspace',
        sessionId: 'sandbox-worker-old',
      }),
      sessionsByAgent: {
        SandboxWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'SandboxWorker',
          currentAgentName: 'SandboxWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'sandbox-worker-old',
          }),
        },
        OtherWorker: {
          backendId: 'fake-sandbox',
          currentAgentKey: 'OtherWorker',
          currentAgentName: 'OtherWorker',
          preservedOwnedSession: true,
          sessionState: fakeSandboxSessionStateEnvelope({
            root: '/workspace',
            sessionId: 'other-worker-old',
          }),
        },
      },
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('preserved owned session cleanup test', async () => {
      await manager.adoptPreservedOwnedSessions();
      await manager.prepareAgent({
        currentAgent: sandboxAgent,
        turnInput: [],
      });
      await manager.cleanup(state);
    });

    expect(client.resumeCalls.map((call) => call.state.sessionId)).toEqual([
      'sandbox-worker-old',
      'other-worker-old',
    ]);
    expect(client.closeCalls).toEqual([
      'sandbox-worker-old',
      'other-worker-old',
    ]);
    expect(state._sandbox).toBeUndefined();
  });

  it('closes owned sandbox sessions on interruption when state cannot be serialized', async () => {
    const client = new FakeSandboxClient();
    Object.defineProperty(client, 'serializeSessionState', {
      value: undefined,
    });
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'requires approval',
      parameters: z.object({}).strict(),
      execute: async () => 'approved',
      needsApproval: true,
    });
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([
        {
          output: [
            {
              id: 'approval-1',
              type: 'function_call',
              name: 'needs_approval',
              callId: 'approval-1',
              status: 'completed',
              arguments: '{}',
            } as any,
          ],
          usage: new Usage(),
        },
      ]),
      tools: [approvalTool],
      defaultManifest: new Manifest({ root: '/workspace' }),
    });

    const result = await new Runner().run(sandboxAgent, 'Hello', {
      sandbox: {
        client,
      },
    });

    expect(result.interruptions).toHaveLength(1);
    expect(result.state._sandbox).toBeUndefined();
    expect(client.closeCalls).toEqual(['session-1']);
  });

  it('drops stale preserved owned sessions when owned sessions are not serialized', async () => {
    const client = new FakeSandboxClient();
    const currentSession = client.makeSession({
      manifest: new Manifest({ root: '/workspace' }),
      sessionId: 'current-session',
    });

    const result = await serializeSandboxRuntimeState({
      client,
      sandboxState: {
        backendId: 'fake-sandbox',
        currentAgentKey: 'PreservedWorker',
        currentAgentName: 'PreservedWorker',
        sessionState: fakeSandboxSessionStateEnvelope({
          root: '/workspace',
          sessionId: 'preserved-session',
        }),
        sessionsByAgent: {
          PreservedWorker: {
            backendId: 'fake-sandbox',
            currentAgentKey: 'PreservedWorker',
            currentAgentName: 'PreservedWorker',
            preservedOwnedSession: true,
            sessionState: fakeSandboxSessionStateEnvelope({
              root: '/workspace',
              sessionId: 'preserved-session',
            }),
          },
          HandoffWorker: {
            backendId: 'fake-sandbox',
            currentAgentKey: 'HandoffWorker',
            currentAgentName: 'HandoffWorker',
            sessionState: fakeSandboxSessionStateEnvelope({
              root: '/workspace',
              sessionId: 'handoff-session',
            }),
          },
        },
      },
      sessionsByAgentKey: new Map([['CurrentWorker', currentSession]]),
      sessionAgentNamesByKey: new Map([['CurrentWorker', 'CurrentWorker']]),
      ownedSessionAgentKeys: new Set(['CurrentWorker']),
      includeOwnedSessions: false,
      preferredCurrentAgentKey: 'CurrentWorker',
    });

    expect(result?.currentAgentKey).toBe('CurrentWorker');
    expect(result?.sessionsByAgent.PreservedWorker).toBeUndefined();
    expect(
      result?.sessionsByAgent.HandoffWorker?.sessionState.providerState,
    ).toMatchObject({
      sessionId: 'handoff-session',
    });
    expect(
      result?.sessionsByAgent.CurrentWorker?.preservedOwnedSession,
    ).toBeUndefined();
    expect(client.serializedOptions).toEqual([
      {
        preserveOwnedSession: false,
        reuseLiveSession: true,
        willCloseAfterSerialize: true,
      },
    ]);
  });

  it('does not reapply an unchanged manifest to a provided session', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'template\n',
          },
        },
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'template\n',
            },
          },
        }),
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await withTrace('provided session test', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
    });

    expect(applyManifest).not.toHaveBeenCalled();
  });

  it('bases implicit provided-session manifests on the live session root', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      capabilities: [new ManifestFileCapability()],
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/app',
        }),
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await withTrace('provided session custom root test', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
    });

    expect(applyManifest).toHaveBeenCalledOnce();
    expect(applyManifest.mock.calls[0]?.[0].root).toBe('/app');
    expect(providedSession.state.manifest.root).toBe('/app');
    expect(providedSession.state.manifest.entries).toMatchObject({
      'generated.txt': {
        type: 'file',
        content: 'generated\n',
      },
    });
  });

  it('applies metadata-only manifest deltas to provided sessions', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        extraPathGrants: [{ path: '/tmp/data', readOnly: true }],
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
        }),
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await withTrace(
      'provided session metadata-only manifest test',
      async () => {
        await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
      },
    );

    expect(applyManifest).toHaveBeenCalledOnce();
    expect(applyManifest.mock.calls[0]?.[0].extraPathGrants).toEqual([
      { path: '/tmp/data', readOnly: true },
    ]);
    expect(providedSession.state.manifest.extraPathGrants).toEqual([
      { path: '/tmp/data', readOnly: true },
    ]);
  });

  it('applies missing nested manifest entries to a provided session', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        entries: {
          repo: {
            type: 'dir',
            children: {
              'task.md': {
                type: 'file',
                content: 'todo\n',
              },
            },
          },
        },
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
          entries: {
            repo: {
              type: 'dir',
            },
          },
        }),
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await withTrace('provided session nested manifest test', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
    });

    expect(applyManifest).toHaveBeenCalledOnce();
    expect(applyManifest.mock.calls[0]?.[0]).toMatchObject({
      entries: {
        'repo/task.md': {
          type: 'file',
          content: 'todo\n',
        },
      },
    });
  });

  it('rejects changed file entries on provided sessions', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'new\n',
          },
        },
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'old\n',
            },
          },
        }),
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await expect(
      withTrace('provided session changed file manifest test', async () => {
        await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
      }),
    ).rejects.toThrow('cannot change manifest entries');

    expect(applyManifest).not.toHaveBeenCalled();
    expect(
      (providedSession.state.manifest.entries['notes.txt'] as any).content,
    ).toBe('old\n');
  });

  it('rejects environment deltas on provided sessions that materialize entries', async () => {
    const materializeEntry = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'template\n',
          },
        },
        environment: {
          TOKEN: 'manifest',
          FEATURE_FLAG: 'enabled',
        },
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
          environment: {
            TOKEN: 'manifest',
          },
        }),
        environment: {
          TOKEN: 'override',
        },
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      materializeEntry,
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await expect(
      withTrace('provided session env test', async () => {
        await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
      }),
    ).rejects.toThrow('cannot change manifest environment variables');

    expect(materializeEntry).not.toHaveBeenCalled();
    expect(providedSession.state.environment).toEqual({
      TOKEN: 'override',
    });
    expect(providedSession.state.manifest.environment.TOKEN?.value).toBe(
      'manifest',
    );
    expect(
      providedSession.state.manifest.environment.FEATURE_FLAG,
    ).toBeUndefined();
  });

  it('rejects environment deltas on provided sessions that apply manifests', async () => {
    const applyManifest = vi.fn();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
      defaultManifest: new Manifest({
        root: '/workspace',
        environment: {
          TOKEN: 'manifest',
          FEATURE_FLAG: 'enabled',
        },
      }),
    });
    const providedSession: SandboxSessionLike<FakeSandboxSessionState> = {
      state: {
        sessionId: 'provided-session',
        manifest: new Manifest({
          root: '/workspace',
          environment: {
            TOKEN: 'manifest',
          },
        }),
        environment: {
          TOKEN: 'override',
        },
      },
      createEditor: () => new StubEditor(),
      execCommand: async () => 'ok',
      viewImage: async () => ({
        type: 'image',
        image: {
          data: Uint8Array.from([137, 80, 78, 71]),
          mediaType: 'image/png',
        },
      }),
      applyManifest,
    };
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        session: providedSession,
      },
    });

    await expect(
      withTrace('provided session apply manifest env test', async () => {
        await manager.prepareAgent({
          currentAgent: sandboxAgent as Agent<unknown, any>,
          turnInput: [],
        });
      }),
    ).rejects.toThrow('cannot change manifest environment variables');

    expect(applyManifest).not.toHaveBeenCalled();
    expect(providedSession.state.environment).toEqual({
      TOKEN: 'override',
    });
    expect(providedSession.state.manifest.environment.TOKEN?.value).toBe(
      'manifest',
    );
    expect(
      providedSession.state.manifest.environment.FEATURE_FLAG,
    ).toBeUndefined();
  });

  it('reuses preserved live owned sessions during same-process resumes', async () => {
    const client = new FakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session preserve test', async () => {
      await firstManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await firstManager.cleanup(state, { preserveOwnedSessions: true });
    });

    const liveSession = client.createdSessions[0];
    expect(liveSession).toBeDefined();
    expect(client.closeCalls).toEqual([]);

    const secondManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session adopt live test', async () => {
      await secondManager.adoptPreservedOwnedSessions();
      await secondManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await secondManager.cleanup(state);
    });

    expect(client.resumeCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual([liveSession?.state.sessionId]);
  });

  it('reuses preserved live owned sessions when the client has no resume API', async () => {
    const client = new FakeSandboxClient();
    (client as unknown as { resume?: undefined }).resume = undefined;
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session no-resume preserve test', async () => {
      await firstManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await firstManager.cleanup(state, { preserveOwnedSessions: true });
    });

    const liveSession = client.createdSessions[0];
    expect(liveSession).toBeDefined();

    const secondManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session no-resume adopt live test', async () => {
      await secondManager.adoptPreservedOwnedSessions();
      await secondManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await secondManager.cleanup(state);
    });

    expect(client.resumeCalls).toHaveLength(0);
    expect(client.closeCalls).toEqual([liveSession?.state.sessionId]);
  });

  it('retains owned session handles so cleanup can retry after close failure', async () => {
    const client = new RecoverableCloseFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session close retry setup', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
    });

    await expect(
      withTrace('owned session close failure test', async () => {
        await manager.cleanup(state);
      }),
    ).rejects.toThrow('Failed to close session-1');

    client.shouldFailClose = false;

    await withTrace('owned session close retry test', async () => {
      await manager.cleanup(state);
    });

    expect(client.closeAttempts).toEqual(['session-1', 'session-1']);
    expect(client.closeCalls).toEqual(['session-1']);
  });

  it('resumes serialized preserved sessions when live reuse is disabled', async () => {
    const client = new SerializedResumeFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    const firstManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session serialized preserve test', async () => {
      await firstManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await firstManager.cleanup(state, { preserveOwnedSessions: true });
    });

    expect(state._sandbox?.sessionsByAgent.SandboxWorker).toMatchObject({
      preservedOwnedSession: true,
      reuseLiveSession: false,
    });
    expect(client.serializedOptions).toEqual([
      {
        preserveOwnedSession: true,
        reuseLiveSession: false,
        willCloseAfterSerialize: false,
      },
    ]);
    expect(client.closeCalls).toEqual(['session-1']);

    const secondManager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session serialized adopt test', async () => {
      await secondManager.adoptPreservedOwnedSessions();
      await secondManager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await secondManager.cleanup(state);
    });

    expect(client.resumeCalls).toHaveLength(1);
    expect(client.closeCalls).toEqual(['session-1', 'session-1']);
  });

  it('skips persisting owned sessions when the client says cleanup destroys them', async () => {
    const client = new NonPersistentFakeSandboxClient();
    const sandboxAgent = new SandboxAgent({
      name: 'SandboxWorker',
      model: new RecordingFakeModel([]),
    });
    const state = new RunState<unknown, Agent<unknown, any>>(
      new RunContext(),
      'Hello',
      sandboxAgent as Agent<unknown, any>,
      1,
    );
    const manager = new SandboxRuntimeManager({
      startingAgent: sandboxAgent as Agent<unknown, any>,
      sandboxConfig: {
        client,
      },
      runState: state,
    });

    await withTrace('owned session persistence test', async () => {
      await manager.prepareAgent({
        currentAgent: sandboxAgent as Agent<unknown, any>,
        turnInput: [],
      });
      await manager.cleanup(state);
    });

    expect(state._sandbox).toBeUndefined();
    expect(client.serializedStates).toHaveLength(0);
    expect(client.closeCalls).toEqual(['session-1']);
  });
});
