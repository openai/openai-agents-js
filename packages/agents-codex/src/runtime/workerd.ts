import { encode, type JsonObject, type JsonValue } from './binding';
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
  isDirectFunctionTool,
  managedApproval,
  outputOf,
  type StandaloneFunctionTool,
} from './tools';

export { AiSdkModel, ResponsesModel } from './models';
export { standaloneTool } from './tools';
export type { NativeModel } from './models';

const frameLimit = 8 * 1024 * 1024;

interface TurnExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  input_buffer(length: number): number;
  apply(): void;
  output_pointer(): number;
  output_length(): number;
}

type Effect =
  | { type: 'model'; request_id: number; body: JsonObject }
  | {
      type: 'tools';
      request_id: number;
      calls: { call_id: string; name: string; arguments: string }[];
    }
  | { type: 'done'; text: string };

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
  maxTurns?: number;
  /** Receive normalized model events in order while the provider stream is open. */
  observe?: (event: Readonly<JsonObject>) => void | Promise<void>;
}

async function completeModel(
  provider: NativeModel,
  request: ModelRequest,
  observe: WorkerTextOptions<unknown>['observe'],
): Promise<ModelResponse> {
  if (!observe || !provider.stream) return provider.complete(request);
  const stream = await provider.stream(request);
  let completion: ModelResponse | undefined;
  let bytes = 0;
  const encoder = new TextEncoder();
  await pumpModelStream(stream, {
    check: () => request.signal.throwIfAborted(),
    start() {},
    async push(encoded, original) {
      bytes += encoder.encode(encoded).length;
      if (bytes > frameLimit)
        throw new RangeError('Portable model stream exceeds capacity');
      if (isRawModelPart(original)) return true;
      const event = JSON.parse(encoded) as JsonObject;
      if (completion)
        throw new Error('Portable model stream emitted data after completion');
      if (
        event.type === 'response.failed' ||
        event.type === 'response.incomplete' ||
        event.type === 'error'
      )
        throw new Error('Portable model stream failed');
      if (event.type === 'response.completed') {
        completion = projectResponsesResponse(event.response);
      }
      await observe(event);
      return true;
    },
    finish() {},
  });
  if (!completion)
    throw new Error('Portable model stream ended without completion');
  return completion;
}

function wireToolOutput(value: unknown): JsonValue {
  const output = outputOf(value);
  if (output.contentItems.every((part) => part.type === 'inputText'))
    return output.contentItems.map((part) => part.text).join('\n');
  throw new TypeError('Portable text tools require text output');
}

async function runTools<Context>(
  effect: Extract<Effect, { type: 'tools' }>,
  tools: ReadonlyMap<string, StandaloneFunctionTool<Context, unknown>>,
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
          siblings.signal.throwIfAborted();
          const result = await tool.invoke(call.arguments, {
            context,
            signal: siblings.signal,
          });
          siblings.signal.throwIfAborted();
          return wireToolOutput(result);
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

/** Run a text turn and its local functions inside a Worker isolate. */
export async function runWorkerText<Context = undefined>(
  input: string,
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
  }: WorkerTextOptions<Context>,
): Promise<string> {
  signal.throwIfAborted();
  if (observe !== undefined && typeof observe !== 'function')
    throw new TypeError('observe must be a callback');
  if (typeof input !== 'string' || typeof instructions !== 'string')
    throw new TypeError('Portable text requires string input and instructions');
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
  const control = new TurnControl(module);
  const owner = { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  let entered = false;
  const execute = async (): Promise<string> => {
    let effect = control.apply({
      type: 'start',
      model,
      instructions,
      input,
      tools: [...toolsByName.values()].map(
        ({ name, description, parameters, strict }) => ({
          name,
          description,
          parameters,
          strict: strict ?? false,
        }),
      ),
      max_turns: maxTurns,
    });
    while (effect) {
      signal.throwIfAborted();
      switch (effect.type) {
        case 'done':
          return effect.text;
        case 'model': {
          const request: ModelRequest = {
            ...owner,
            runOwner: owner,
            context,
            signal,
            body: effect.body,
          };
          entered = true;
          const response: ModelResponse = await completeModel(
            provider,
            request,
            observe,
          );
          signal.throwIfAborted();
          effect = control.apply({
            type: 'model',
            request_id: effect.request_id,
            output: captureModelResponse(response).output,
          });
          break;
        }
        case 'tools': {
          const { request_id, calls } = effect;
          const outputs = await runTools(effect, toolsByName, context, signal);
          signal.throwIfAborted();
          effect = null;
          for (const [index, output] of outputs.entries()) {
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
    try {
      control.apply({ type: 'cancel' });
    } finally {
      if (entered) await provider.cleanupOnRunEnd?.(owner);
    }
  };
  let text: string;
  try {
    text = await execute();
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
  return text;
}
