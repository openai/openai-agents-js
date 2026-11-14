import { isDeepStrictEqual } from 'node:util';
import {
  bindModelProviderMetadata,
  captureModelProviderStreamFrame,
} from './model-provider-metadata';
import { encode, type JsonObject, type JsonValue } from './binding';
import type { SessionStore } from './custom-thread-store';
import { captureGuardrailResult, type GuardrailResult } from './guardrails';
import {
  assertOutputRepairSupported,
  prepareOutput,
  type OutputSpec,
  type PreparedOutput,
} from './output';
import {
  captureModelResponse,
  isRawModelPart,
  projectResponsesResponse,
  pumpModelStream,
  type ModelRequest,
  type ModelResponse,
  type NativeModel,
} from './models';
import {
  invokeGuardedStandalone,
  isDirectFunctionTool,
  managedApproval,
  outputOf,
  prepareStandaloneApproval,
  type StandaloneFunctionTool,
} from './tools';

export { AiSdkModel, ResponsesModel } from './models';
export { OutputValidationError } from './output';
export type { OutputSpec } from './output';
export { standaloneTool } from './tools';
export type { NativeModel } from './models';
export type { SessionStore } from './custom-thread-store';

const frameLimit = 8 * 1024 * 1024;

interface TurnExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  input_buffer(length: number): number;
  apply(): void;
  output_pointer(): number;
  output_length(): number;
}

type Effect =
  | {
      type: 'model';
      request_id: number;
      body: JsonObject;
      provider_metadata?: JsonValue;
      profile: string | null;
    }
  | {
      type: 'tools';
      profile: string | null;
      request_id: number;
      calls: { call_id: string; name: string; arguments: string }[];
    }
  | {
      type: 'approval';
      request_id: number;
      revision: number;
      effective_arguments?: JsonObject;
      profile: string | null;
      call: { call_id: string; name: string; arguments: string };
    }
  | { type: 'checkpoint'; snapshot: { revision: number } }
  | {
      type: 'done';
      text: string;
      profile: string | null;
      snapshot: { revision: number };
    };

class TurnControl {
  readonly #exports: TurnExports;

  constructor(control: WebAssembly.Module) {
    if (WebAssembly.Module.imports(control).length)
      throw new TypeError(
        'Native text control cannot import host capabilities',
      );
    this.#exports = new WebAssembly.Instance(control).exports as TurnExports;
    const exports = this.#exports;
    if (
      !(exports.memory instanceof WebAssembly.Memory) ||
      typeof exports.input_buffer !== 'function' ||
      typeof exports.apply !== 'function' ||
      typeof exports.output_pointer !== 'function' ||
      typeof exports.output_length !== 'function'
    )
      throw new TypeError('Invalid native text control module');
  }

  apply(command: unknown): Effect | null {
    const exports = this.#exports;
    const bytes = new TextEncoder().encode(encode(command, frameLimit));
    const pointer = exports.input_buffer(bytes.length);
    if (!pointer) throw new TypeError('Native text command exceeds capacity');
    new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
    exports.apply();
    const response = new Uint8Array(
      exports.memory.buffer,
      exports.output_pointer(),
      exports.output_length(),
    );
    const reply = JSON.parse(new TextDecoder().decode(response)) as {
      effect: Effect | null;
      error?: string;
    };
    if (reply.error) throw new Error(reply.error);
    return reply.effect;
  }
}

export interface WorkerToolApproval<Context> {
  readonly profile: string | null;
  readonly callId: string;
  readonly name: string;
  readonly arguments: Readonly<JsonObject>;
  readonly context: Context | undefined;
  readonly signal: AbortSignal;
}

export interface WorkerGuardrail<Context> {
  readonly name: string;
  /** For input checks, allow sampling to begin before the result. */
  readonly runInParallel?: boolean;
  readonly callback: (request: {
    readonly text: string;
    readonly context: Context | undefined;
    readonly signal: AbortSignal;
    readonly profile: string | null;
    readonly sessionId: string;
    readonly turnId: string;
  }) => GuardrailResult | Promise<GuardrailResult>;
}

export type WorkerToolGuardrailResult =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason: string }
  | { readonly action: 'stop'; readonly outputInfo?: unknown };

export interface WorkerToolGuardrail<Context> {
  readonly name: string;
  readonly before?: (
    call: WorkerToolApproval<Context>,
  ) => WorkerToolGuardrailResult | Promise<WorkerToolGuardrailResult>;
  readonly after?: (
    call: WorkerToolApproval<Context> & { readonly output: string },
  ) => WorkerToolGuardrailResult | Promise<WorkerToolGuardrailResult>;
}

export class WorkerGuardrailTripwire extends Error {
  constructor(
    readonly kind: 'input' | 'output' | 'tool_input' | 'tool_output',
    readonly guardrail: string,
    readonly result: GuardrailResult,
  ) {
    super('Worker run blocked by guardrail');
    this.name = 'WorkerGuardrailTripwire';
  }
}

export interface WorkerApprovalDecision {
  readonly callId: string;
  readonly revision: number;
  readonly approved: boolean;
}

export interface WorkerPendingApproval {
  type: 'approval';
  callId: string;
  revision: number;
  name: string;
  profile: string | null;
  arguments: JsonObject;
}

export type WorkerTextResult =
  { type: 'completed'; text: string } | WorkerPendingApproval;

export type WorkerOutputResult<Output> =
  { type: 'completed'; text: string; output: Output } | WorkerPendingApproval;

export interface WorkerAgentProfile<Context> {
  model: string;
  instructions: string;
  provider?: NativeModel;
  tools?: readonly StandaloneFunctionTool<Context, unknown>[];
  approve?: Readonly<
    Record<
      string,
      (
        call: WorkerToolApproval<Context>,
      ) => boolean | null | Promise<boolean | null>
    >
  >;
  inputGuardrails?: readonly WorkerGuardrail<Context>[];
  outputGuardrails?: readonly WorkerGuardrail<Context>[];
  toolGuardrails?: Readonly<
    Record<string, readonly WorkerToolGuardrail<Context>[]>
  >;
  /** Current function names and their captured destination profile IDs. */
  handoffs?: Readonly<Record<string, string>>;
}

export interface WorkerTextOptions<Context> {
  /** Precompiled module from `@openai/agents-codex/worker/control.wasm`. */
  control: WebAssembly.Module;
  /** Application model adapter, including the native AiSdkModel and ResponsesModel. */
  provider: NativeModel;
  model: string;
  instructions: string;
  tools?: readonly StandaloneFunctionTool<Context, unknown>[];
  context?: Context;
  signal?: AbortSignal;
  /** Decide before dispatching. Returning null pauses a turn backed by a session store. */
  approve?: Readonly<
    Record<
      string,
      (
        call: WorkerToolApproval<Context>,
      ) => boolean | null | Promise<boolean | null>
    >
  >;
  /** Blocking checks on each new input before the first model request. */
  inputGuardrails?: readonly WorkerGuardrail<Context>[];
  /** Checks on the final text before returning it or saving a completed turn. */
  outputGuardrails?: readonly WorkerGuardrail<Context>[];
  toolGuardrails?: Readonly<
    Record<string, readonly WorkerToolGuardrail<Context>[]>
  >;
  maxTurns?: number;
  /** The store must grant an exclusive writer lease and atomically commit the revision. */
  session?: { id: string; store: SessionStore };
  /** The current Agent declarations own all handoff and tool authority. */
  agents?: {
    root: string;
    profiles: Readonly<Record<string, WorkerAgentProfile<Context>>>;
  };
  /** Receive normalized model events in order while the provider stream is open. */
  observe?: (event: Readonly<JsonObject>) => void | Promise<void>;
}

async function completeModel(
  provider: NativeModel,
  request: ModelRequest,
  observe: WorkerTextOptions<unknown>['observe'],
): Promise<JsonObject> {
  if (!observe || !provider.stream)
    return captureModelResponse(await provider.complete(request));
  const stream = await provider.stream(request);
  let completion: ModelResponse | undefined;
  let responseId: string | undefined;
  const outputItems = new Map<number, JsonValue>();
  const providerMetadata: JsonObject[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  await pumpModelStream(stream, {
    check: () => request.signal.throwIfAborted(),
    start() {},
    async push(encoded, original) {
      bytes += encoder.encode(encoded).length;
      if (bytes > frameLimit)
        throw new RangeError('Portable model stream exceeds capacity');
      if (completion)
        throw new Error('Portable model stream emitted data after completion');
      if (isRawModelPart(original)) return true;
      if (Object.hasOwn(original, '__sdk_model_provider_metadata'))
        throw new Error(
          'Portable model stream cannot supply private metadata envelopes',
        );
      const captured = captureModelProviderStreamFrame(encoded, original);
      if (captured !== encoded) {
        bytes +=
          encoder.encode(captured).length - encoder.encode(encoded).length;
        if (bytes > frameLimit || providerMetadata.length >= 4096)
          throw new RangeError('Portable model metadata exceeds capacity');
        providerMetadata.push(
          (JSON.parse(captured) as JsonObject)
            .__sdk_model_provider_metadata as JsonObject,
        );
      }
      const event = JSON.parse(encoded) as JsonObject;
      if (
        event.type === 'response.failed' ||
        event.type === 'response.incomplete' ||
        event.type === 'error'
      )
        throw new Error('Portable model stream failed');
      if (event.type === 'response.created') {
        const response = event.response;
        if (
          responseId !== undefined ||
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          typeof response.id !== 'string' ||
          !response.id.trim()
        )
          throw new Error('Portable model stream emitted an invalid creation');
        responseId = response.id;
      } else if (event.type === 'response.output_item.done') {
        const index = event.output_index;
        if (
          typeof index !== 'number' ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          outputItems.has(index) ||
          !event.item ||
          typeof event.item !== 'object' ||
          Array.isArray(event.item)
        )
          throw new Error(
            'Portable model stream emitted an invalid output item',
          );
        outputItems.set(index, structuredClone(event.item));
      } else if (event.type === 'response.completed') {
        const response = event.response;
        if (
          !response ||
          typeof response !== 'object' ||
          Array.isArray(response) ||
          typeof response.id !== 'string' ||
          !response.id.trim() ||
          (responseId !== undefined && responseId !== response.id) ||
          response.status !== 'completed' ||
          !Array.isArray(response.output)
        )
          throw new Error(
            'Portable model stream emitted an invalid completion',
          );
        if (
          outputItems.size &&
          (outputItems.size !== response.output.length ||
            response.output.some(
              (item, index) => !isDeepStrictEqual(item, outputItems.get(index)),
            ))
        )
          throw new Error('Portable model stream changed completed output');
        completion = projectResponsesResponse(structuredClone(response));
      }
      await observe(event);
      return true;
    },
    finish() {},
  });
  if (!completion)
    throw new Error('Portable model stream ended without completion');
  const captured = captureModelResponse(completion);
  if (providerMetadata.length) captured.provider_metadata = providerMetadata;
  return captured;
}

function wireToolOutput(value: unknown): string {
  const output = outputOf(value);
  if (output.contentItems.every((part) => part.type === 'inputText'))
    return output.contentItems.map((part) => part.text).join('\n');
  throw new TypeError('Portable text tools require text output');
}

function workerCall<Context>(
  call: Extract<Effect, { type: 'approval' }>['call'],
  profile: string | null,
  context: Context | undefined,
  signal: AbortSignal,
): WorkerToolApproval<Context> {
  const args: unknown = JSON.parse(call.arguments);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new TypeError('Worker tool policies require JSON object arguments');
  return {
    profile,
    callId: call.call_id,
    name: call.name,
    arguments: args as JsonObject,
    context,
    signal,
  };
}

async function runTools<Context>(
  effect: Extract<Effect, { type: 'tools' }>,
  tools: ReadonlyMap<string, StandaloneFunctionTool<Context, unknown>>,
  policies: ReadonlyMap<string, readonly WorkerToolGuardrail<Context>[]>,
  prepared: ReadonlyMap<string, ReturnType<typeof prepareStandaloneApproval>>,
  context: Context | undefined,
  signal: AbortSignal,
) {
  const siblings = new AbortController();
  const abort = () => siblings.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const outcomes = await Promise.allSettled(
      effect.calls.map(async (call) => {
        try {
          const tool = tools.get(call.name);
          if (!tool)
            throw new Error('Native text issued an unavailable function');
          const signal = siblings.signal;
          signal.throwIfAborted();
          const guards = policies.get(call.name) ?? [];
          const approved = prepared.get(call.call_id);
          const request = (effective: JsonObject) => ({
            profile: effect.profile,
            callId: call.call_id,
            name: call.name,
            arguments: structuredClone(effective),
            context,
            signal,
          });
          const evaluate = (
            kind: 'tool_input' | 'tool_output',
            name: string,
            verdict: WorkerToolGuardrailResult,
          ) => {
            signal.throwIfAborted();
            if (verdict?.action === 'allow') return undefined;
            if (
              verdict?.action === 'deny' &&
              typeof verdict.reason === 'string'
            )
              return verdict.reason;
            if (verdict?.action !== 'stop')
              throw new TypeError('Invalid Worker tool guardrail verdict');
            throw new WorkerGuardrailTripwire(kind, name, {
              tripwireTriggered: true,
              outputInfo: verdict.outputInfo,
            });
          };
          let executedArguments: JsonObject | undefined;
          const admission = guards.length
            ? async (effective: JsonObject) => {
                for (const guard of guards) {
                  if (!guard.before) continue;
                  const verdict = await guard.before(request(effective));
                  const denial = evaluate('tool_input', guard.name, verdict);
                  if (denial !== undefined) return denial;
                }
                executedArguments = effective;
              }
            : undefined;
          const result = approved
            ? await approved.execute(admission)
            : admission
              ? await invokeGuardedStandalone(
                  tool,
                  call.arguments,
                  { context, signal },
                  admission,
                )
              : await tool.invoke(call.arguments, { context, signal });
          signal.throwIfAborted();
          const output = wireToolOutput(result);
          for (const guard of guards) {
            if (!guard.after || !executedArguments) continue;
            const verdict = await guard.after({
              ...request(executedArguments),
              output,
            });
            const denial = evaluate('tool_output', guard.name, verdict);
            if (denial !== undefined) return denial;
          }
          return output;
        } catch (error) {
          siblings.abort(error);
          throw error;
        }
      }),
    );
    siblings.signal.throwIfAborted();
    return outcomes.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function captureTools<Context>(
  tools: readonly StandaloneFunctionTool<Context, unknown>[],
) {
  const toolsByName = new Map<
    string,
    StandaloneFunctionTool<Context, unknown>
  >();
  for (const tool of tools) {
    if (
      typeof tool.invoke !== 'function' ||
      !isDirectFunctionTool(tool) ||
      managedApproval(tool) ||
      tool.namespace ||
      tool.finishTurn ||
      toolsByName.has(tool.name)
    )
      throw new TypeError(
        'Portable text requires unique direct standalone functions',
      );
    toolsByName.set(tool.name, tool);
  }
  return toolsByName;
}

function captureApprovals<Context>(
  tools: ReadonlyMap<string, StandaloneFunctionTool<Context, unknown>>,
  policies: WorkerTextOptions<Context>['approve'],
) {
  const approvals = new Map(Object.entries(policies ?? {}));
  for (const [name, callback] of approvals) {
    if (!tools.has(name) || typeof callback !== 'function')
      throw new TypeError(
        'Worker approval requires a current tool and a callback',
      );
  }
  return approvals;
}

function captureWorkerToolGuardrails<Context>(
  tools: ReadonlyMap<string, StandaloneFunctionTool<Context, unknown>>,
  policies: WorkerTextOptions<Context>['toolGuardrails'],
) {
  return new Map(
    Object.entries(policies ?? {}).map(([tool, checks]) => {
      if (!tools.has(tool) || !Array.isArray(checks))
        throw new TypeError('Worker tool guardrails require a current tool');
      return [
        tool,
        checks.map((check: WorkerToolGuardrail<Context>) => {
          const { name, before, after } = check;
          if (
            typeof name !== 'string' ||
            !name.trim() ||
            (!before && !after) ||
            (before !== undefined && typeof before !== 'function') ||
            (after !== undefined && typeof after !== 'function')
          )
            throw new TypeError(
              'Worker tool guardrail requires a name and a callback',
            );
          return {
            name,
            before: before?.bind(check),
            after: after?.bind(check),
          };
        }),
      ] as const;
    }),
  );
}

function captureWorkerGuardrails<Context>(
  guards: readonly WorkerGuardrail<Context>[] = [],
) {
  return guards.map((guard) => {
    const { name, callback, runInParallel } = guard;
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      typeof callback !== 'function' ||
      (runInParallel !== undefined && typeof runInParallel !== 'boolean')
    )
      throw new TypeError('Worker guardrail requires a name and a callback');
    return { name, callback: callback.bind(guard), runInParallel };
  });
}

function wireTools<Context>(
  tools: ReadonlyMap<string, StandaloneFunctionTool<Context, unknown>>,
  approvals: ReadonlyMap<string, unknown>,
) {
  return [...tools.values()].map(
    ({ name, description, parameters, strict }) => ({
      name,
      description,
      parameters,
      strict: strict ?? false,
      requires_approval: approvals.has(name),
    }),
  );
}

function workerOutputRequest(
  body: JsonObject,
  output?: PreparedOutput,
): JsonObject {
  if (output?.schema) {
    return {
      ...body,
      text: {
        format: {
          type: 'json_schema',
          name: 'codex_output_schema',
          strict: output.strict ?? true,
          schema: structuredClone(output.schema),
        },
      },
    };
  }
  if (output?.prompt) {
    return {
      ...body,
      input: [
        ...(body.input as JsonValue[]),
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: output.prompt }],
        },
      ],
    };
  }
  return body;
}

/** Run a text turn and its local functions inside a Worker isolate. */
export async function runWorkerText<Context = undefined>(
  input: string,
  options: WorkerTextOptions<Context>,
): Promise<string> {
  const result = await runWorkerTextTurn(input, options, false);
  if (result.type === 'completed') return result.text;
  throw new Error('Use runWorkerTurn to pause for tool approval');
}

/** Run or resume a turn with a captured native output type and tool approvals. */
export function runWorkerTurn<Output, Context = undefined>(
  input: string | WorkerApprovalDecision,
  options: WorkerTextOptions<Context> & { outputType: OutputSpec<Output> },
): Promise<WorkerOutputResult<Output>>;
/** Run or resume a text turn with an explicit result for a pending tool approval. */
export function runWorkerTurn<Context = undefined>(
  input: string | WorkerApprovalDecision,
  options: WorkerTextOptions<Context>,
): Promise<WorkerTextResult>;
export async function runWorkerTurn<Context>(
  input: string | WorkerApprovalDecision,
  options: WorkerTextOptions<Context> & { outputType?: OutputSpec<unknown> },
): Promise<WorkerTextResult | WorkerOutputResult<unknown>> {
  const output = options.outputType
    ? prepareOutput(options.outputType)
    : undefined;
  if (output) assertOutputRepairSupported(output);
  return runWorkerTextTurn(input, options, true, output);
}

async function runWorkerTextTurn<Context>(
  input: string | WorkerApprovalDecision,
  {
    control: module,
    provider,
    model,
    instructions,
    tools = [],
    context,
    signal = new AbortController().signal,
    maxTurns = 10,
    observe,
    session,
    agents,
    approve,
    inputGuardrails,
    outputGuardrails,
    toolGuardrails,
  }: WorkerTextOptions<Context>,
  allowPause: boolean,
  output?: PreparedOutput,
): Promise<WorkerTextResult | WorkerOutputResult<unknown>> {
  signal.throwIfAborted();
  if (observe !== undefined && typeof observe !== 'function')
    throw new TypeError('observe must be a callback');
  if (typeof instructions !== 'string')
    throw new TypeError('Portable text requires string instructions');
  const decision = typeof input === 'string' ? undefined : input;
  if (
    typeof input !== 'string' &&
    (!session ||
      !decision ||
      typeof decision.callId !== 'string' ||
      !Number.isSafeInteger(decision.revision) ||
      decision.revision < 1 ||
      typeof decision.approved !== 'boolean')
  ) {
    throw new TypeError(
      'Worker approval requires a stored session and a valid decision',
    );
  }
  let pendingDecision = decision;
  const toolsByName = captureTools(tools);
  const approvals = captureApprovals(toolsByName, approve);
  const inputChecks = captureWorkerGuardrails(inputGuardrails);
  const outputChecks = captureWorkerGuardrails(outputGuardrails);
  const toolChecks = captureWorkerToolGuardrails(toolsByName, toolGuardrails);
  const profiles = new Map(
    Object.entries(agents?.profiles ?? {}).map(([id, profile]) => {
      const tools = captureTools(profile.tools ?? []);
      return [
        id,
        {
          provider: profile.provider ?? provider,
          model: profile.model,
          instructions: profile.instructions,
          tools,
          approvals: captureApprovals(tools, profile.approve),
          inputChecks: captureWorkerGuardrails(profile.inputGuardrails),
          outputChecks: captureWorkerGuardrails(profile.outputGuardrails),
          toolChecks: captureWorkerToolGuardrails(
            tools,
            profile.toolGuardrails,
          ),
          handoffs: Object.fromEntries(Object.entries(profile.handoffs ?? {})),
        },
      ];
    }),
  );
  const currentProfile = (id: string | null) => {
    if (id === null) return undefined;
    const profile = profiles.get(id);
    if (!profile) throw new Error('Native text issued an unavailable profile');
    return profile;
  };
  if (session && (typeof session.id !== 'string' || !session.id))
    throw new TypeError('A Worker session requires a nonempty string ID');
  const control = new TurnControl(module);
  const owner = {
    sessionId: session?.id ?? crypto.randomUUID(),
    turnId: crypto.randomUUID(),
  };
  const usedProviders = new Set<NativeModel>();
  const prepared = new Map<
    string,
    ReturnType<typeof prepareStandaloneApproval>
  >();
  const checkGuards = async (
    kind: 'input' | 'output',
    checks: readonly WorkerGuardrail<Context>[],
    text: string,
    profile: string | null,
    currentSignal: AbortSignal,
  ) => {
    const settled = await Promise.allSettled(
      checks.map(async (guard) => {
        currentSignal.throwIfAborted();
        const result = captureGuardrailResult(
          await guard.callback({
            text,
            context,
            signal: currentSignal,
            profile,
            ...owner,
          }),
        );
        currentSignal.throwIfAborted();
        if (result.tripwireTriggered)
          throw new WorkerGuardrailTripwire(kind, guard.name, result);
      }),
    );
    const failed = settled.find((entry) => entry.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  };
  const firstModel = async (
    effect: Extract<Effect, { type: 'model' }>,
    userInput: string,
    sample: (signal: AbortSignal) => Promise<JsonObject>,
  ) => {
    const checks = [
      ...inputChecks,
      ...(currentProfile(effect.profile)?.inputChecks ?? []),
    ];
    await checkGuards(
      'input',
      checks.filter((guard) => !guard.runInParallel),
      userInput,
      effect.profile,
      signal,
    );
    const parallel = checks.filter((guard) => guard.runInParallel);
    if (!parallel.length) return sample(signal);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const cancelSibling = (error: unknown): never => {
      controller.abort(error);
      throw error;
    };
    const guarded = checkGuards(
      'input',
      parallel,
      userInput,
      effect.profile,
      combined,
    ).catch(cancelSibling);
    const sampled = sample(combined).catch(cancelSibling);
    const [guard, response] = await Promise.allSettled([guarded, sampled]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (guard.status === 'rejected') throw guard.reason;
    if (response.status === 'rejected') throw response.reason;
    return response.value;
  };
  type StoredResult = {
    result: WorkerTextResult | WorkerOutputResult<unknown>;
    snapshot: { revision: number };
  };
  type Commit = (snapshot: StoredResult['snapshot']) => Promise<void>;
  const execute = async (
    snapshot: JsonValue,
    commit?: Commit,
  ): Promise<StoredResult> => {
    let effect = control.apply({
      type: 'start',
      model,
      instructions,
      input: typeof input === 'string' ? input : null,
      tools: wireTools(toolsByName, approvals),
      profiles: agents
        ? {
            root: agents.root,
            declarations: Object.fromEntries(
              [...profiles].map(([id, profile]) => [
                id,
                {
                  model: profile.model,
                  instructions: profile.instructions,
                  tools: wireTools(profile.tools, profile.approvals),
                  handoffs: profile.handoffs,
                },
              ]),
            ),
          }
        : null,
      max_turns: maxTurns,
      ...(output ? { output_contract: output.identity.fingerprint } : {}),
      snapshot,
    });
    let initialInput = typeof input === 'string' ? input : undefined;
    while (effect) {
      signal.throwIfAborted();
      switch (effect.type) {
        case 'done': {
          const typed = output?.parse ? output.parse(effect.text) : effect.text;
          await checkGuards(
            'output',
            [
              ...outputChecks,
              ...(currentProfile(effect.profile)?.outputChecks ?? []),
            ],
            effect.text,
            effect.profile,
            signal,
          );
          return {
            result: {
              type: 'completed',
              text: effect.text,
              ...(output ? { output: typed } : {}),
            },
            snapshot: effect.snapshot,
          };
        }
        case 'checkpoint':
          throw new Error('Unexpected Worker checkpoint');
        case 'model': {
          const requestEffect = effect;
          const sample = (modelSignal: AbortSignal) => {
            const request: ModelRequest = {
              ...owner,
              runOwner: owner,
              context,
              signal: modelSignal,
              body: workerOutputRequest(requestEffect.body, output),
            };
            bindModelProviderMetadata(request, requestEffect.provider_metadata);
            const modelProvider =
              currentProfile(requestEffect.profile)?.provider ?? provider;
            usedProviders.add(modelProvider);
            return completeModel(modelProvider, request, observe);
          };
          const response =
            initialInput === undefined
              ? await sample(signal)
              : await firstModel(requestEffect, initialInput, sample);
          initialInput = undefined;
          signal.throwIfAborted();
          effect = control.apply({
            type: 'model',
            request_id: effect.request_id,
            output: response.output,
            provider_metadata: response.provider_metadata ?? [],
          });
          break;
        }
        case 'approval': {
          const { call, request_id, revision, profile, effective_arguments } =
            effect;
          const selected = currentProfile(profile);
          const tool = (selected?.tools ?? toolsByName).get(call.name);
          if (!tool)
            throw new Error('Native text issued an unavailable approval tool');
          const original = workerCall(call, profile, context, signal);
          const validated = prepareStandaloneApproval(
            tool,
            original.arguments,
            context,
            signal,
          );
          const args = validated.arguments;
          if (pendingDecision && !isDeepStrictEqual(args, effective_arguments))
            throw new Error(
              'Worker approval arguments changed after validation',
            );
          const checkpoint = (claim: boolean) => {
            const checkpoint = control.apply({
              type: 'checkpoint',
              request_id,
              call_id: call.call_id,
              claim,
              effective_arguments: args,
            });
            if (checkpoint?.type !== 'checkpoint')
              throw new Error('Worker approval checkpoint is unavailable');
            return checkpoint.snapshot;
          };
          const policy = (currentProfile(profile)?.approvals ?? approvals).get(
            call.name,
          );
          if (!policy)
            throw new Error('Native text issued an unavailable approval');
          const request = { ...original, arguments: structuredClone(args) };
          let approved: boolean | null;
          if (pendingDecision) {
            if (
              !commit ||
              pendingDecision.callId !== call.call_id ||
              pendingDecision.revision !== revision
            )
              throw new Error(
                'Worker approval decision does not match the pending call',
              );
            approved = pendingDecision.approved;
            pendingDecision = undefined;
          } else {
            approved = await policy(request);
          }
          signal.throwIfAborted();
          if (approved === null) {
            if (!allowPause || !commit)
              throw new Error(
                'Worker approval pauses require runWorkerTurn with a session store',
              );
            const snapshot = checkpoint(false);
            return {
              result: {
                type: 'approval',
                callId: call.call_id,
                revision: snapshot.revision,
                name: call.name,
                profile,
                arguments: args as JsonObject,
              },
              snapshot,
            };
          }
          if (typeof approved !== 'boolean')
            throw new TypeError(
              'Worker approval must return a boolean or null',
            );
          // Persist the claim before dispatch, so a failed result commit cannot replay a side effect.
          if (approved && commit) await commit(checkpoint(true));
          signal.throwIfAborted();
          if (approved) prepared.set(call.call_id, validated);
          effect = control.apply({
            type: 'approval',
            request_id,
            call_id: call.call_id,
            approved,
          });
          break;
        }
        case 'tools': {
          const { request_id, calls } = effect;
          const outputs = await runTools(
            effect,
            currentProfile(effect.profile)?.tools ?? toolsByName,
            currentProfile(effect.profile)?.toolChecks ?? toolChecks,
            prepared,
            context,
            signal,
          );
          signal.throwIfAborted();
          effect = null;
          for (const [index, output] of outputs.entries()) {
            prepared.delete(calls[index].call_id);
            effect = control.apply({
              type: 'tool',
              request_id,
              call_id: calls[index].call_id,
              output,
            });
          }
          break;
        }
      }
    }
    throw new Error('Portable text control ended without a result');
  };
  const close = async () => {
    const failures: unknown[] = [];
    try {
      control.apply({ type: 'cancel' });
    } catch (error) {
      failures.push(error);
    }
    for (const outcome of await Promise.allSettled(
      [...usedProviders].map(async (used) => used.cleanupOnRunEnd?.(owner)),
    )) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
    if (failures.length)
      throw new AggregateError(failures, 'Worker turn cleanup failed');
  };
  const run = async (snapshot: JsonValue, commit?: Commit) => {
    let result;
    try {
      result = await execute(snapshot, commit);
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Worker turn and cleanup failed',
        );
      }
      throw error;
    }
    await close();
    return result;
  };
  if (!session) return (await run(null)).result;
  const { id, store } = session;
  const fence = await store.acquire(id);
  let releaseNeeded = true;
  try {
    signal.throwIfAborted();
    const stored = await store.read(id, fence);
    if (stored !== null && new TextEncoder().encode(stored).length > frameLimit)
      throw new RangeError('Portable session snapshot exceeds capacity');
    signal.throwIfAborted();
    const commit: Commit = async (snapshot) => {
      signal.throwIfAborted();
      await store.commit(
        id,
        fence,
        `${owner.turnId}:${snapshot.revision}`,
        snapshot.revision - 1,
        JSON.stringify(snapshot),
      );
      await store.flush?.(id, fence);
    };
    const result = await run(
      stored === null ? null : JSON.parse(stored),
      commit,
    );
    await commit(result.snapshot);
    releaseNeeded = false;
    await store.release(id, fence);
    return result.result;
  } catch (error) {
    if (releaseNeeded) {
      try {
        await store.release(id, fence);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Worker session and lease release failed',
        );
      }
    }
    throw error;
  }
}
