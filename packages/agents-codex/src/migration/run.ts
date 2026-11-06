import {
  loadCompletedSessionInput,
  appendCompletedSessionItems,
  sessionModelInput,
} from './persistence';
import {
  Agent,
  type AgentOutputType,
  RunContext,
  RunHooks,
  type Model,
  type ModelSettings,
  type FunctionTool,
  type InputGuardrailResult,
  type OutputGuardrailResult,
  type OutputGuardrailMetadata,
  type ToolInputGuardrailDefinition,
  type ToolInputGuardrailResult,
  type ToolOutputGuardrailDefinition,
  type ToolOutputGuardrailResult,
  type Runner,
} from '@openai/agents-core';
import { isDeepStrictEqual } from 'node:util';
import type { ResolvedAgentOutput } from '@openai/agents-core/types';
import { captureOutput } from './output';
import type { SerializedFunctionTool } from '@openai/agents-core/model';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  inspectFunctionToolForMigration,
  AgentToolUseTracker,
  maybeResetToolChoice,
  AGENT_TOOL_RUNNER_FACTORY,
  prepareModelSettings,
  selectModel,
} from '@openai/agents-core/utils/internal';
import { openSession } from '../runtime/agent';
import { NativeProvider } from '../runtime/provider';
import { TurnAborted, type Session } from '../runtime/session';
import { captureTools, migrationTool } from '../runtime/tools';
import {
  binding,
  jsonObject,
  jsonValue,
  type JsonObject,
} from '../runtime/binding';
import {
  bounded,
  SelectedModelInvocation,
  validateSettings,
  validateToolChoice,
} from './model';
import { resolveInstructions } from './instructions';
import { captureFinishBehavior, resolveToolFinish } from './finish';
import { migrationItems, migrationResult } from './result';
import { captureNativeHandoff, NativeHandoffState } from './handoff';
import { migrationStream } from './stream';
import { prepareAgentToolRun, type AgentToolExecution } from './agent-tool';
import { runWithApproval, type HeldApprovalOwner } from './approvals';
import type { StreamEvent } from '@openai/agents-core';
import { nativeCarrier, sdkInputItems } from './input';
import { captureCompletedHistory } from './history';
import {
  captureNativePersistence,
  recordedCallIds,
} from './native-persistence';
import { assertOutputState, type SessionState } from '../runtime/state';
import { persistentSessionConfig } from '../runtime/config';
import type {
  MigrationRunOptions,
  MigrationRunResult,
  MigrationApprovalOptions,
} from './index';
import type { MigrationPausedRun } from './approvals';
import {
  checkFinalOutput,
  emitAgentEnd,
  emitAgentStart,
  invokeGuardedTool,
  runInputChecks,
} from './boundaries';

/** A failed owned cleanup attempt. Retry joins only this invocation's existing owners. */
export class MigrationCleanupError extends AggregateError {
  private constructor(
    errors: unknown[],
    cause: unknown,
    readonly retryCleanup: () => Promise<void>,
  ) {
    super(
      errors,
      'Migration cleanup failed; retryCleanup retries remaining cleanup only',
      { cause },
    );
    this.name = 'MigrationCleanupError';
  }
  /** @internal */
  static from(errors: unknown[], cause: unknown, cleanup: () => Promise<void>) {
    return new MigrationCleanupError(errors, cause, cleanup);
  }
}

function reject(message: string): never {
  throw new TypeError(
    `Migration ${message}; use @openai/agents/classic for the full classic runtime`,
  );
}

function requireGuardrail(name: unknown, callback: unknown): void {
  if (typeof name !== 'string' || typeof callback !== 'function')
    reject('requires named guardrails with executable callbacks');
}

function snapshotModelSettings(settings: ModelSettings): ModelSettings {
  const { retry, ...dataSettings } = settings;
  return {
    ...structuredClone(dataSettings),
    ...(retry === undefined
      ? {}
      : {
          retry: {
            ...retry,
            ...(retry.backoff === undefined
              ? {}
              : { backoff: { ...retry.backoff } }),
          },
        }),
  };
}

/** @internal Whole-declaration admission runs before provider or resource work. */
export function capture<Context, Output extends AgentOutputType = 'text'>(
  agent: Agent<Context, Output>,
  input: string | readonly AgentInputItem[],
  options: MigrationRunOptions<Context, Output> & { approvals?: 'manual' },
  requiredInvocation?: 'stream',
) {
  if (
    !(agent instanceof Agent) ||
    Object.getPrototypeOf(agent) !== Agent.prototype
  )
    reject('requires a matched ordinary classic Agent');
  if (
    typeof agent.instructions !== 'string' &&
    typeof agent.instructions !== 'function'
  )
    reject('requires string or callable instructions');
  const output = captureOutput(agent);
  const sdkInput =
    typeof input === 'string' ? input : captureCompletedHistory(input);
  bounded(sdkInput);
  const capturedInput = nativeCarrier(sdkInput);
  const sdkItems =
    typeof sdkInput === 'string'
      ? sdkInputItems(sdkInput)
      : structuredClone(sdkInput);
  if (
    !options ||
    typeof options !== 'object' ||
    !Object.hasOwn(options, 'context')
  )
    reject('requires explicit context');
  for (const key of Object.keys(options)) {
    if (
      ![
        'approvals',
        'context',
        'session',
        'sessionInputCallback',
        'state',
        'storage',
        'resume',
        'reconciledCalls',
        'returnState',
        'signal',
        'model',
        'modelProvider',
        'modelSettings',
        'modelInvocation',
        'inputGuardrails',
        'outputGuardrails',
        'hooks',
      ].includes(key)
    )
      reject(`does not support run option ${key}`);
  }
  const {
    context,
    signal,
    model: runModel,
    modelProvider,
    modelSettings: runModelSettings,
    modelInvocation = requiredInvocation ?? 'response',
    hooks,
    approvals,
  } = options;
  if (approvals !== undefined && approvals !== 'manual')
    reject('requires manual approvals');
  if (requiredInvocation && approvals !== undefined)
    reject('stream() does not support held approvals');
  if (signal !== undefined && !(signal instanceof AbortSignal))
    reject('requires an AbortSignal');
  if (modelInvocation !== 'response' && modelInvocation !== 'stream')
    reject('requires response or stream invocation');
  if (requiredInvocation && modelInvocation !== requiredInvocation)
    reject('stream() requires the Model streaming method');
  if (hooks !== undefined && !(hooks instanceof RunHooks))
    reject('requires RunHooks or Runner lifecycle hooks');
  if (
    agent.prompt !== undefined ||
    agent.mcpServers.length ||
    Object.keys(agent.mcpConfig).length
  )
    reject('does not support prompts or MCP');
  if (
    !Array.isArray(agent.inputGuardrails) ||
    !Array.isArray(agent.outputGuardrails) ||
    (options.inputGuardrails !== undefined &&
      !Array.isArray(options.inputGuardrails)) ||
    (options.outputGuardrails !== undefined &&
      !Array.isArray(options.outputGuardrails))
  )
    reject('requires guardrail arrays');
  const inputGuardrails = [
    ...(options.inputGuardrails ?? []),
    ...agent.inputGuardrails,
  ].map(({ name, execute, runInParallel }) => {
    requireGuardrail(name, execute);
    if (runInParallel !== undefined && typeof runInParallel !== 'boolean')
      reject('requires a boolean runInParallel guardrail option');
    return { name, execute, runInParallel };
  });
  const outputGuardrails = [
    ...(options.outputGuardrails ?? []),
    ...agent.outputGuardrails,
  ].map(({ name, execute }) => {
    requireGuardrail(name, execute);
    return { name, execute };
  });
  const selected = selectModel(agent.model, runModel);
  if (
    typeof selected === 'string' &&
    (!selected.trim() || typeof modelProvider?.getModel !== 'function')
  )
    reject(
      'requires an explicit Model or nonempty model name with an explicit ModelProvider',
    );
  if (runModelSettings) validateSettings(runModelSettings);
  const settings = prepareModelSettings(
    agent,
    runModelSettings,
    true,
    typeof selected === 'string' ? selected : undefined,
  ).modelSettings;
  validateSettings(settings);
  const names = new Set<string>();
  const tools: {
    declaration: SerializedFunctionTool;
    parameters: JsonObject;
    invoke: FunctionTool<Context>['invoke'];
    source: FunctionTool<Context, any, any>;
    agentTool?: Agent<Context, 'text'>;
    approval: boolean;
    inputGuardrails?: ToolInputGuardrailDefinition<Context>[];
    outputGuardrails?: ToolOutputGuardrailDefinition<Context>[];
  }[] = [];
  for (const source of agent.tools) {
    if (
      Object.getPrototypeOf(source) !== Object.prototype ||
      Object.values(Object.getOwnPropertyDescriptors(source)).some(
        (field) => !('value' in field),
      )
    )
      reject('requires inspectable factory function declarations');
    if (source.type !== 'function')
      reject('requires ordinary registered function tools');
    if (
      typeof source.name !== 'string' ||
      !source.name ||
      typeof source.description !== 'string'
    )
      reject('requires named function tools with string descriptions');
    const facts = inspectFunctionToolForMigration(source, {
      allowApproval: approvals === 'manual',
      allowAgentTools: approvals !== 'manual',
    });
    if (facts.sourceAgent && facts.sourceAgent.outputType !== 'text')
      reject('requires text output for an Agent tool');
    if (
      source.strict !== true ||
      source.deferLoading ||
      source.providerData !== undefined ||
      source.allowedCallers !== undefined ||
      source.outputSchema !== undefined ||
      source.timeoutMs !== undefined ||
      source.customDataExtractor !== undefined ||
      ('namespace' in source && source.namespace !== undefined)
    )
      reject(
        'does not support deferred, namespaced, provider, caller, output, timeout or custom tool policies',
      );
    if (names.has(source.name))
      reject(`has duplicate function name ${source.name}`);
    names.add(source.name);
    const declaration: SerializedFunctionTool = {
      type: 'function',
      name: source.name,
      description: source.description,
      parameters: structuredClone(source.parameters),
      strict: true,
    };
    const parameters = jsonObject.parse(declaration.parameters);
    if (
      (source.inputGuardrails !== undefined &&
        !Array.isArray(source.inputGuardrails)) ||
      (source.outputGuardrails !== undefined &&
        !Array.isArray(source.outputGuardrails))
    )
      reject('requires function-tool guardrail arrays');
    const toolInputGuardrails = source.inputGuardrails?.map((guard) => {
      const { name, run } = guard;
      requireGuardrail(name, run);
      return { type: 'tool_input' as const, name, run: run.bind(guard) };
    });
    const toolOutputGuardrails = source.outputGuardrails?.map((guard) => {
      const { name, run } = guard;
      requireGuardrail(name, run);
      return { type: 'tool_output' as const, name, run: run.bind(guard) };
    });
    if (facts.enabled)
      tools.push({
        declaration,
        parameters,
        source,
        agentTool: facts.sourceAgent as Agent<Context, 'text'> | undefined,
        approval: facts.approval === true,
        invoke: source.invoke,
        inputGuardrails: toolInputGuardrails,
        outputGuardrails: toolOutputGuardrails,
      });
  }
  if (typeof agent.resetToolChoice !== 'boolean')
    reject('requires a boolean resetToolChoice');
  const finishBehavior = captureFinishBehavior(agent.toolUseBehavior);
  const persistence = captureNativePersistence(options);
  if (persistence.enabled) {
    if (
      options.session !== undefined ||
      options.sessionInputCallback !== undefined
    )
      reject('requires one persistence source');
    if (typeof sdkInput !== 'string')
      reject('requires fresh text input with native persistence');
    if (agent.handoffs.length)
      reject('does not support handoffs with native persistence');
    if (persistence.returnState && agent.toolUseBehavior !== 'run_llm_again')
      reject('requires native turn completion to return portable state');
    assertOutputState(persistence.sessionOptions.state, output.native.identity);
  }
  const enabledNames = new Set(tools.map((tool) => tool.declaration.name));
  validateToolChoice(options.modelSettings?.toolChoice, enabledNames);
  validateToolChoice(settings.toolChoice, enabledNames);
  if (approvals === 'manual' && tools.length !== 1)
    reject('manual approval requires one enabled registered function');
  return {
    approvals,
    output,
    input: capturedInput,
    runOptions: options,
    sdkInput,
    sdkItems,
    context,
    signal,
    modelProvider,
    modelInvocation,
    sessionStore: options.session,
    persistence,
    sessionInputCallback: options.sessionInputCallback,
    hooks,
    inputGuardrails,
    outputGuardrails,
    selected,
    settings: snapshotModelSettings(settings),
    agentToolRunConfig: {
      model: runModel,
      modelProvider,
      modelSettings:
        runModelSettings === undefined
          ? undefined
          : snapshotModelSettings(runModelSettings),
    },
    tools,
    finishBehavior,
    instructions:
      typeof agent.instructions === 'string' ? agent.instructions : '',
    name: agent.name,
  };
}

/** @internal */
export function run<Context, Output extends AgentOutputType = 'text'>(
  agent: Agent<Context, Output>,
  input: string | readonly AgentInputItem[],
  options: MigrationApprovalOptions<Context, Output>,
): Promise<
  MigrationRunResult<Context, Output> | MigrationPausedRun<Context, Output>
>;
export function run<Context, Output extends AgentOutputType = 'text'>(
  agent: Agent<Context, Output>,
  input: string | readonly AgentInputItem[],
  options: MigrationRunOptions<Context, Output>,
): Promise<MigrationRunResult<Context, Output>>;
export async function run<Context, Output extends AgentOutputType = 'text'>(
  agent: Agent<Context, Output>,
  input: string | readonly AgentInputItem[],
  options: MigrationRunOptions<Context, Output> & { approvals?: 'manual' },
) {
  const captured = capture(agent, input, options);
  return captured.approvals === 'manual'
    ? runWithApproval(agent, (owner) =>
        runCaptured(agent, captured, undefined, owner),
      )
    : runCaptured(agent, captured);
}

/** Experimental live Model channel with guarded buffered SDK semantic events. */
export async function stream<Context>(
  agent: Agent<Context, 'text'>,
  input: string | readonly AgentInputItem[],
  options: MigrationRunOptions<Context>,
) {
  const captured = capture(agent, input, options, 'stream');
  return migrationStream(
    (signal, publish) => runCaptured(agent, { ...captured, signal }, publish),
    captured.signal,
  );
}

async function runCaptured<Context, Output extends AgentOutputType = 'text'>(
  agent: Agent<Context, Output>,
  captured: ReturnType<typeof capture<Context, Output>>,
  publish?: (event: StreamEvent) => void,
  approvals?: HeldApprovalOwner<Context>,
  execution?: AgentToolExecution<Context>,
): Promise<MigrationRunResult<Context, Output>> {
  const runContext = execution?.runContext ?? new RunContext(captured.context);
  type Captured = ReturnType<typeof capture<Context, Output>>;
  const scopes = new Map<Agent<Context, Output>, Captured>([[agent, captured]]);
  const authority = (owner: Agent<Context, Output>, value: Captured) => ({
    approvals: value.approvals,
    selected: value.selected,
    settings: value.settings,
    instructions: value.instructions,
    instructionSource: owner.instructions,
    finishBehavior: value.finishBehavior,
    resetToolChoice: owner.resetToolChoice,
    name: value.name,
    inputGuardrails: value.inputGuardrails,
    outputGuardrails: value.outputGuardrails,
    tools: value.tools.map((tool) => ({
      source: tool.source,
      invoke: tool.invoke,
      declaration: tool.declaration,
      approval: tool.approval,
      agentTool: tool.agentTool,
      inputGuardrails: tool.source.inputGuardrails?.map(({ name, run }) => ({
        name,
        run,
      })),
      outputGuardrails: tool.source.outputGuardrails?.map(({ name, run }) => ({
        name,
        run,
      })),
    })),
  });
  const snapshots = new Map<
    Agent<Context, Output>,
    ReturnType<typeof authority>
  >([[agent, authority(agent, captured)]]);
  const handoff = captureNativeHandoff(agent, (currentAgent) => {
    const current = capture(
      currentAgent,
      captured.sdkInput,
      captured.runOptions,
    );
    if (
      typeof captured.selected === 'string' ||
      current.selected !== captured.selected ||
      captured.modelInvocation !== 'response'
    )
      reject(
        'handoffs require the same explicit Model and response invocation',
      );
    const original = snapshots.get(currentAgent);
    if (
      original &&
      !isDeepStrictEqual(original, authority(currentAgent, current))
    )
      reject('captured handoff Agent configuration changed');
    if (!original) {
      scopes.set(currentAgent, current);
      snapshots.set(currentAgent, authority(currentAgent, current));
    }
  });
  const target = handoff ? scopes.get(handoff.target)! : undefined;
  if (handoff && captured.approvals === 'manual')
    reject('handoffs with held approvals are not yet supported');
  if (
    handoff &&
    (execution ||
      captured.tools.some((tool) => tool.agentTool) ||
      target?.tools.some((tool) => tool.agentTool))
  )
    reject('handoffs with Agent tools are not yet supported');
  const definitions = [
    ...captured.tools.map((tool) => ({ ...tool, owner: agent })),
    ...(target
      ? target.tools.map((tool) => ({ ...tool, owner: handoff!.target }))
      : []),
  ];
  const declarations = [
    ...definitions.map((tool) => tool.declaration),
    ...(handoff ? [handoff.declaration] : []),
  ];
  if (
    new Set(declarations.map((tool) => tool.name)).size !== declarations.length
  )
    reject('requires disjoint Root, Target and handoff function names');
  if (handoff && captured.sessionStore)
    reject('handoffs with Session storage are not yet supported');
  const prepared = captured.sessionStore
    ? await loadCompletedSessionInput(
        captured.sessionStore,
        captured.sdkInput,
        captured.sessionInputCallback,
        runContext,
      )
    : undefined;
  if (prepared) {
    captured.input = prepared.nativeInput;
    captured.sdkInput = structuredClone(prepared.modelInput);
    captured.sdkItems = structuredClone(prepared.modelInput);
  }

  const invocation = new SelectedModelInvocation<Context, Output>(
    declarations,
    captured.settings,
    captured.modelInvocation,
    runContext,
    captured.output.model,
    prepared?.bridge ??
      (Array.isArray(captured.sdkInput)
        ? sessionModelInput(captured.sdkInput, [])
        : undefined),
    captured.persistence.restore,
  );
  if (handoff && target) {
    invocation.handoff = new NativeHandoffState(
      handoff,
      {
        agent,
        instructions: captured.instructions,
        settings: captured.settings,
        tools: captured.tools.map((tool) => tool.declaration),
      },
      {
        agent: handoff.target,
        instructions: target.instructions,
        settings: target.settings,
        tools: target.tools.map((tool) => tool.declaration),
      },
      runContext,
      captured.sdkInput,
      captured.hooks,
      {
        responses: invocation.responses,
        observations: (responses) => invocation.getObservations(responses),
        check: () => invocation.check(),
        startTarget: (input) =>
          emitAgentStart({
            agent: handoff.target,
            context: runContext,
            hooks: captured.hooks,
            input,
          }),
      },
    );
  }
  invocation.callerSignal = captured.signal;
  invocation.rawModelEvent = publish;
  invocation.validateApprovalResponse = approvals?.validateResponse;
  const inContext = invocation.inContext;
  const toolUse = new AgentToolUseTracker();
  invocation.toolAccepted = (name) => {
    const definition = definitions.find(
      (tool) => tool.declaration.name === name,
    );
    if (definition) toolUse.addToolUse(definition.owner, [name]);
  };
  invocation.prepareRequest = async (request) => {
    const activeAgent = invocation.handoff?.agent ?? agent;
    request.systemInstructions = await resolveInstructions(
      activeAgent,
      runContext,
      invocation.controller.signal,
    );
    request.modelSettings = maybeResetToolChoice(
      activeAgent,
      toolUse,
      request.modelSettings,
    );
  };
  invocation.finishTools = () => {
    const activeAgent = invocation.handoff?.agent ?? agent;
    const activeCapture = scopes.get(activeAgent)!;
    return resolveToolFinish(
      activeCapture.finishBehavior,
      runContext,
      invocation.getToolResults(
        activeAgent,
        activeCapture.tools.map((tool) => tool.source),
      ),
      invocation.controller.signal,
    );
  };
  const abort = () => invocation.fail(captured.signal!.reason);
  captured.signal?.addEventListener('abort', abort, { once: true });
  if (captured.signal?.aborted) abort();
  let provider: NativeProvider | undefined;
  // openSession erases the prepared-output generic; this owner supplies its captured parser.
  let session: Session<ResolvedAgentOutput<Output>> | undefined;
  let finalOutput: ResolvedAgentOutput<Output> | undefined;
  let state: SessionState | undefined;
  let policyOutput: string | undefined;
  let nativeInfo: MigrationRunResult['native'] | undefined;
  let policyFinished = false;
  let handoffProjection: ReturnType<
    NativeHandoffState<Context, Output>['projection']
  >;
  let inputChecks:
    ReturnType<typeof runInputChecks<Context, Output>> | undefined;
  const inputGuardrailResults: InputGuardrailResult[] = [];
  const outputGuardrailResults: OutputGuardrailResult<
    OutputGuardrailMetadata,
    Output
  >[] = [];
  const toolInputGuardrailResults: ToolInputGuardrailResult[] = [];
  const toolOutputGuardrailResults: ToolOutputGuardrailResult[] = [];
  let cleanupPending: Promise<void> | undefined;
  let clean = false;
  const childCleanup = new Set<MigrationCleanupError>();
  const cleanup = ({
    halt = true,
    retryChildren = false,
  } = {}): Promise<void> => {
    if (halt) invocation.halt();
    if (clean) return Promise.resolve();
    if (!cleanupPending) {
      cleanupPending = (async () => {
        // Producer ownership is independent of native close, including its rejection path.
        let closeFailure: unknown;
        let closeFailed = false;
        try {
          await session?.close();
        } catch (error) {
          closeFailed = true;
          closeFailure = error;
        }
        const failures: unknown[] = closeFailed ? [closeFailure] : [];
        try {
          await invocation.join();
        } catch (error) {
          failures.push(error);
        }
        await inputChecks?.join();
        for (const child of childCleanup) {
          if (!retryChildren) {
            failures.push(child);
            continue;
          }
          try {
            await child.retryCleanup();
            childCleanup.delete(child);
          } catch (error) {
            failures.push(error);
          }
        }
        if (!closeFailed) {
          try {
            await provider?.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Migration cleanup failed');
        clean = true;
      })().finally(() => {
        cleanupPending = undefined;
      });
    }
    return cleanupPending;
  };
  const finalize = async () => {
    invocation.check();
    const activeAgent = invocation.handoff?.agent ?? agent;
    const activeCapture = scopes.get(activeAgent)!;
    handoffProjection = invocation.handoff?.projection();
    outputGuardrailResults.push(
      ...(await inContext(() =>
        checkFinalOutput({
          agent: activeAgent,
          context: runContext,
          output: finalOutput!,
          agentGuardrails: activeCapture.outputGuardrails,
          details: {
            modelResponse: invocation.responses.at(-1),
            output:
              handoffProjection?.items.map((item) => item.rawItem) ??
              invocation.getOutputItems(),
          },
          onFailure: (error) => invocation.fail(error),
        }),
      )),
    );
    invocation.check();
    inContext(() =>
      emitAgentEnd({
        agent: activeAgent,
        context: runContext,
        output: finalOutput!,
        hooks: captured.hooks,
      }),
    );
    invocation.check();
  };
  try {
    invocation.check();
    inputChecks = inContext(() =>
      runInputChecks({
        agent,
        context: runContext,
        input: captured.sdkInput,
        agentGuardrails: captured.inputGuardrails,
        onFailure: (error) => invocation.fail(error),
      }),
    );
    inputGuardrailResults.push(...(await inputChecks.blocking));
    invocation.check();
    let parallelChecks: Promise<InputGuardrailResult[]> | undefined;
    invocation.inputChecks = () =>
      (parallelChecks ??= inputChecks!.startParallel().then((results) => {
        inputGuardrailResults.push(...results);
        return results;
      }));
    inContext(() =>
      emitAgentStart({
        agent,
        context: runContext,
        hooks: captured.hooks,
        input: captured.sdkItems,
      }),
    );
    invocation.check();
    const tools = definitions.map(
      ({
        declaration,
        parameters,
        source,
        agentTool,
        invoke,
        approval,
        inputGuardrails,
        outputGuardrails,
        owner,
      }) =>
        migrationTool<Context, { allowed: boolean }>(
          {
            name: declaration.name,
            description: declaration.description,
            parameters,
          },
          async (argumentsText, nativeContext, prepared, checkNative) => {
            try {
              invocation.handoff?.assertTool(
                declaration.name,
                nativeContext.callId,
              );
              if (prepared?.allowed === false)
                return invocation.toolValue(
                  nativeContext.callId,
                  declaration.name,
                  'Tool execution was not approved.',
                );
              const signal = AbortSignal.any([
                nativeContext.signal,
                invocation.controller.signal,
              ]);
              const toolCall = invocation.getToolCall(
                nativeContext.callId,
                declaration.name,
              );
              const details: NonNullable<Parameters<typeof invoke>[2]> = {
                signal,
                toolCall,
              };
              if (agentTool) {
                details.parentRunConfig = captured.agentToolRunConfig;
                details[AGENT_TOOL_RUNNER_FACTORY] = (config) => {
                  const runner = {
                    async run(
                      actualAgent: unknown,
                      input: unknown,
                      options: unknown,
                    ) {
                      const child = prepareAgentToolRun(
                        agentTool,
                        toolCall,
                        config,
                        actualAgent,
                        input,
                        options,
                      );
                      try {
                        return await runCaptured(
                          child.agent,
                          capture(child.agent, child.input, child.options),
                          undefined,
                          undefined,
                          child.execution,
                        );
                      } catch (error) {
                        if (error instanceof MigrationCleanupError) {
                          childCleanup.add(error);
                          invocation.fail(error);
                        }
                        throw error;
                      }
                    },
                  };
                  // Agent.asTool's completed path consumes this facade; live Runner state is unsupported.
                  return runner as unknown as Pick<Runner, 'run'>;
                };
              }
              const value = await inContext(() =>
                invokeGuardedTool({
                  agent: owner,
                  context: runContext,
                  tool: source,
                  toolCall,
                  signal,
                  hooks: captured.hooks,
                  inputGuardrails,
                  outputGuardrails,
                  check: () => {
                    invocation.check();
                    invocation.handoff?.assertTool(
                      declaration.name,
                      nativeContext.callId,
                    );
                    if (prepared) checkNative();
                  },
                  invoke: () => invoke(runContext, argumentsText, details),
                  onInputResult: (result) =>
                    toolInputGuardrailResults.push(result),
                  onOutputResult: (result) =>
                    toolOutputGuardrailResults.push(result),
                }),
              );
              return invocation.toolValue(
                nativeContext.callId,
                declaration.name,
                jsonValue.parse(value),
              );
            } catch (error) {
              invocation.fail(error);
              throw error;
            }
          },
          () => invocation.check(),
          approvals && approval
            ? async (_argumentsText, nativeContext) => {
                try {
                  invocation.check();
                  const call = invocation.responses
                    .flatMap((response) => response.output)
                    .find(
                      (item) =>
                        item.type === 'function_call' &&
                        item.callId === nativeContext.callId,
                    );
                  if (
                    !call ||
                    call.type !== 'function_call' ||
                    call.name !== declaration.name
                  )
                    throw new TypeError(
                      'Approval requires the actual matching SDK function call',
                    );
                  const allowed = await inContext(() =>
                    approvals.hold(call, nativeContext, runContext),
                  );
                  invocation.check();
                  return { allowed };
                } catch (error) {
                  invocation.fail(error);
                  throw error;
                }
              }
            : undefined,
        ),
    );
    if (handoff) {
      tools.push(
        migrationTool(
          {
            name: handoff.declaration.name,
            description: handoff.declaration.description,
            parameters: jsonObject.parse(handoff.declaration.parameters),
          },
          async (_argumentsText, nativeContext) => {
            try {
              const value = await inContext(() =>
                invocation.handoff!.invoke(nativeContext.callId),
              );
              return invocation.toolValue(
                nativeContext.callId,
                handoff.declaration.name,
                value,
              );
            } catch (error) {
              invocation.fail(error);
              throw error;
            }
          },
          () => invocation.check(),
        ),
      );
    }
    const catalog = captureTools(tools);
    const native = await binding();
    invocation.check();
    native._validate_python_tool_declarations(catalog.specsJson);
    const model: Model =
      typeof captured.selected === 'string'
        ? await inContext(() =>
            captured.modelProvider!.getModel(captured.selected as string),
          )
        : captured.selected;
    invocation.check();
    if (
      !model ||
      typeof model.getResponse !== 'function' ||
      typeof model.getStreamedResponse !== 'function'
    )
      reject('requires a Model with both response methods');
    invocation.model = model;
    provider = new NativeProvider({
      apiKey: 'agents-sdk-selected-model',
      supportsWebsockets: false,
    });
    const lease = provider._acquire();
    try {
      const home = await lease.open();
      invocation.check();
      session = (await openSession(
        {
          name: captured.name,
          instructions: captured.instructions,
          model: 'agents-sdk-model',
          tools: catalog.tools,
          selectedModel: invocation,
          apiKey: lease.apiKey,
          config: {
            ...lease.config,
            'model_providers.native_agent': {
              name: 'Selected classic Model',
              base_url: 'http://127.0.0.1',
              wire_api: 'responses',
              requires_openai_auth: false,
              supports_websockets: false,
              request_max_retries: 0,
              stream_max_retries: 0,
            },
            include_permissions_instructions: false,
            include_environment_context: false,
            'agents.enabled': false,
            'features.goals': false,
            ...(captured.persistence.sessionOptions.localStorage
              ? persistentSessionConfig
              : {}),
            'tools.update_plan.enabled': false,
            mcp_servers: {},
            'features.non_prefixed_mcp_tool_names': false,
            'features.code_mode': {
              enabled: false,
              direct_only_tool_namespaces: ['functions'],
            },
            web_search: 'disabled',
          },
          runtime: {
            ...home,
            ...captured.persistence.runtime,
            _sdk_selected_model: true,
            strict_config: true,
            loader: { ignore_user_config: true, ignore_project_config: true },
            approval_policy: 'never',
            base_instructions:
              'Follow the application instructions and use only the supplied tools.',
          },
          threadOptions: {
            ...captured.persistence.threadOptions,
            tool_policy: {
              allowed_tools: catalog.tools.map((tool) => ({
                name: tool.name,
                namespace: 'functions',
              })),
            },
          },
        },
        {
          ...captured.persistence.sessionOptions,
          context: captured.context,
          output: captured.output.native,
          selectedModel: invocation,
          onClose: lease.release,
        },
        lease,
        undefined,
        catalog,
      )) as Session<ResolvedAgentOutput<Output>>;
      lease.openingSucceeded();
    } catch (error) {
      invocation.fail(error);
      try {
        await lease.failOpening(error, false);
      } catch {
        /* Existing owner retains failed opening cleanup. */
      }
      throw error;
    }
    invocation.cancelNative = () => {
      void session!.interrupt({ scope: 'root', mode: 'force' }).catch(() => {});
    };
    if (captured.persistence.enabled)
      invocation.nativeCallIds = captured.persistence.restore
        ? recordedCallIds(await session._rootHistory())
        : new Set();
    invocation.check();
    const turn = await session.submit(captured.input, { ifBusy: 'reject' });
    const nativeResult = turn.wait().then(
      (value) => ({ type: 'completed' as const, value }),
      (error: unknown) => ({ type: 'error' as const, error }),
    );
    const outcome = await Promise.race([
      nativeResult,
      invocation.finishRequested.promise.then((candidate) => ({
        type: 'tool_finish' as const,
        candidate,
      })),
    ]);
    if (outcome.type === 'error') throw outcome.error;
    if (outcome.type === 'completed') {
      finalOutput = outcome.value.finalOutput;
      nativeInfo = {
        sessionId: session.id,
        turnId: outcome.value.turn.turnId,
        usage: outcome.value.usage,
      };
      await finalize();
      if (captured.persistence.returnState) state = await session.saveState();
    } else {
      invocation.check();
      await turn.cancel({ mode: 'force' });
      const stopped = await nativeResult;
      invocation.check();
      const terminal = invocation.nativeTerminal;
      if (
        stopped.type !== 'error' ||
        !(stopped.error instanceof TurnAborted) ||
        !terminal ||
        terminal.turnId !== turn.turnId ||
        terminal.kind !== 'turn_aborted' ||
        terminal.reason !== 'interrupted' ||
        terminal.nativeError != null ||
        (terminal.priorFailure != null &&
          terminal.priorFailure !== stopped.error) ||
        terminal.nativeFailure != null ||
        terminal.error !== stopped.error
      ) {
        if (stopped.type === 'error') throw stopped.error;
        throw new Error(
          'Migration tool finish requires the owned interrupted native turn',
        );
      }
      policyOutput = outcome.candidate.finalOutput;
      nativeInfo = {
        sessionId: session.id,
        turnId: turn.turnId,
        usage: terminal.usage,
        outcome: { type: terminal.kind, reason: terminal.reason },
      };
      policyFinished = true;
    }
  } catch (error) {
    invocation.fail(error);
  }
  try {
    if (policyFinished && !invocation.failed) {
      // Stop and physically join native owners before validating the adapter result.
      // Keep the SDK/caller signal live through the common finalizer.
      await cleanup({ halt: false });
      try {
        invocation.check();
        // Plain text has no parser; admitted object output has the captured validator.
        finalOutput = captured.output.native.parse
          ? captured.output.native.parse(policyOutput!)
          : (policyOutput as ResolvedAgentOutput<Output>);
        await finalize();
      } catch (error) {
        invocation.fail(error);
      }
    }
    await cleanup();
  } catch (error) {
    invocation.halt();
    const errors: unknown[] = [];
    const append = (value: unknown) => {
      if (value instanceof AggregateError) value.errors.forEach(append);
      else if (!errors.includes(value)) errors.push(value);
    };
    if (invocation.failed) append(invocation.failure);
    append(error);
    throw MigrationCleanupError.from(
      errors,
      invocation.failed ? invocation.failure : errors[0],
      () => cleanup({ retryChildren: true }),
    );
  } finally {
    captured.signal?.removeEventListener('abort', abort);
  }
  if (invocation.failed) throw invocation.failure;
  const observations = invocation.getObservations();
  // Keep accepted effect facts separate from a future filtered consumer view.
  const acceptedItems = migrationItems(agent, observations);
  const acceptedTransition = invocation.handoff?.acceptedTransition;
  const transition =
    acceptedTransition && handoffProjection
      ? {
          agent: acceptedTransition.prepared.outputItem.targetAgent,
          // Subtract the actual target suffix; filtered items grant no authority.
          afterItemCount:
            handoffProjection.items.length -
            migrationItems(
              acceptedTransition.prepared.outputItem.targetAgent,
              invocation.getObservations(
                invocation.responses.slice(
                  acceptedTransition.responseIndex + 1,
                ),
              ),
            ).length,
        }
      : undefined;
  const result = migrationResult(
    {
      ...(execution
        ? { agentToolInvocation: execution.agentToolInvocation }
        : {}),
      finalOutput: finalOutput!,
      modelResponses: Object.freeze([...invocation.responses]),
      inputGuardrailResults: Object.freeze(inputGuardrailResults),
      outputGuardrailResults: Object.freeze(outputGuardrailResults),
      toolInputGuardrailResults: Object.freeze(toolInputGuardrailResults),
      toolOutputGuardrailResults: Object.freeze(toolOutputGuardrailResults),
      native: Object.freeze(nativeInfo!),
      ...(state === undefined ? {} : { state }),
    },
    invocation.handoff?.agent ?? agent,
    runContext,
    captured.input,
    observations,
    {
      ...(handoffProjection ?? {
        input: captured.sdkInput,
        items: acceptedItems,
      }),
      transition,
    },
  );
  if (captured.sessionStore && prepared) {
    await appendCompletedSessionItems(
      captured.sessionStore,
      [...prepared.sessionItems, ...acceptedItems.map((item) => item.rawItem)],
      runContext,
    );
  }
  return result;
}
