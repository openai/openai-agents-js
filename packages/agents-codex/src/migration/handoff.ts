import { isDeepStrictEqual } from 'node:util';
import {
  Agent,
  type AgentOutputType,
  getHandoff,
  getTransferMessage,
  RunHandoffCallItem,
  RunMessageOutputItem,
  RunHandoffOutputItem,
  type Handoff,
  type HandoffInputData,
  type RunContext,
  type RunHooks,
  type RunItem,
  type ModelRequest,
  type ModelResponse,
  type ModelSettings,
  type protocol,
} from '@openai/agents-core';
import type {
  SerializedFunctionTool,
  SerializedHandoff,
} from '@openai/agents-core/model';
import { getToolCallOutputItem } from '@openai/agents-core/utils/internal';
import type { AgentInputItem } from '@openai/agents-core/types';
import {
  migrationItems,
  type MigrationItem,
  type MigrationObservation,
} from './result';
import type { ToolResponse } from '../runtime/tools';

export type CapturedNativeHandoff<
  TContext,
  TOutput extends AgentOutputType = 'text',
> = {
  source: Agent<TContext, TOutput>;
  target: Agent<TContext, TOutput>;
  handoff: Handoff<TContext, TOutput>;
  declaration: SerializedFunctionTool;
  serializedHandoff: SerializedHandoff;
  check: () => void;
  enabled: (context: RunContext<TContext>) => Promise<boolean>;
  invoke: Handoff<TContext, TOutput>['onInvokeHandoff'];
  filter: Handoff<TContext, TOutput>['inputFilter'];
};

export type PreparedNativeHandoff = {
  input: HandoffInputData;
  outputItem: RunHandoffOutputItem;
  transferMessage: string;
  commitItems: readonly RunItem[];
};

/** Accepted transfer facts retain the SDK objects independently of filtered history. */
export type AcceptedNativeHandoff = Readonly<{
  callId: string;
  responseIndex: number;
  prepared: Readonly<Pick<PreparedNativeHandoff, 'outputItem' | 'commitItems'>>;
}>;

/** Captures one declared transfer without changing the active Agent. */
export function captureNativeHandoff<
  TContext,
  TOutput extends AgentOutputType = 'text',
>(
  source: Agent<TContext, TOutput>,
  verifyAgent: (agent: Agent<TContext, TOutput>) => void,
): CapturedNativeHandoff<TContext, TOutput> | undefined {
  if (source.handoffs.length === 0) return undefined;
  if (source.handoffs.length !== 1)
    throw new TypeError('Migration supports one static handoff');
  const entry = source.handoffs[0];
  const handoff = getHandoff<TContext, TOutput>(entry);
  const target = handoff.agent;
  if (!(target instanceof Agent) || target === source || target.handoffs.length)
    throw new TypeError('Migration requires a distinct terminal handoff Agent');
  if (source.outputType !== 'text' || target.outputType !== 'text')
    throw new TypeError('Migration handoff currently requires text Agents');
  verifyAgent(source);
  verifyAgent(target);
  const invoke = handoff.onInvokeHandoff;
  const filter = handoff.inputFilter;
  const enabled = handoff.isEnabled;
  const declaration = structuredClone(handoff.getHandoffAsFunctionTool());
  if (
    declaration.strict !== true ||
    typeof declaration.name !== 'string' ||
    declaration.name.length === 0 ||
    typeof declaration.description !== 'string' ||
    typeof declaration.parameters !== 'object' ||
    declaration.parameters === null ||
    Array.isArray(declaration.parameters) ||
    typeof invoke !== 'function' ||
    (filter != null && typeof filter !== 'function')
  )
    throw new TypeError('Migration requires a strict handoff declaration');
  const agentName = handoff.agentName;
  const check = () => {
    if (source.outputType !== 'text' || target.outputType !== 'text')
      throw new TypeError('Migration handoff Agent output changed');
    verifyAgent(source);
    verifyAgent(target);
    if (
      source.handoffs.length !== 1 ||
      source.handoffs[0] !== entry ||
      handoff.agent !== target ||
      target === source ||
      target.handoffs.length !== 0 ||
      handoff.agentName !== agentName ||
      handoff.onInvokeHandoff !== invoke ||
      handoff.inputFilter !== filter ||
      handoff.isEnabled !== enabled ||
      !isDeepStrictEqual(handoff.getHandoffAsFunctionTool(), declaration)
    )
      throw new TypeError('Migration handoff configuration changed');
  };
  return {
    source,
    target,
    handoff,
    declaration,
    serializedHandoff: {
      toolName: declaration.name,
      toolDescription: declaration.description,
      inputJsonSchema: structuredClone(declaration.parameters),
      strictJsonSchema: true,
    },
    check,
    enabled: async (context) => {
      check();
      const result = await enabled.call(handoff, {
        runContext: context,
        agent: source,
      });
      check();
      return result;
    },
    invoke,
    filter,
  };
}

/** Prepares history and callback effects; native acceptance owns the transition. */
export async function prepareNativeHandoff<
  TContext,
  TOutput extends AgentOutputType = 'text',
>(
  plan: CapturedNativeHandoff<TContext, TOutput>,
  options: {
    context: RunContext<TContext>;
    call: protocol.FunctionCallItem;
    input: HandoffInputData;
    hooks?: RunHooks<TContext, TOutput>;
    check: () => void;
  },
): Promise<PreparedNativeHandoff> {
  const check = () => {
    options.check();
    plan.check();
  };
  check();
  if (options.call.name !== plan.declaration.name)
    throw new TypeError(
      'Migration handoff call does not match the active Agent',
    );
  const target = await plan.invoke.call(
    plan.handoff,
    options.context,
    options.call.arguments,
  );
  check();
  if (target !== plan.target)
    throw new TypeError('Migration handoff returned an undeclared Agent');
  const transferMessage = getTransferMessage(target);
  const outputItem = new RunHandoffOutputItem(
    getToolCallOutputItem(options.call, transferMessage),
    plan.source,
    target,
  );
  options.hooks?.emit('agent_handoff', options.context, plan.source, target);
  check();
  plan.source.emit('agent_handoff', options.context, target);
  check();
  const commitItems = [...options.input.newItems, outputItem];
  const input: HandoffInputData = {
    inputHistory: Array.isArray(options.input.inputHistory)
      ? [...options.input.inputHistory]
      : options.input.inputHistory,
    preHandoffItems: [...options.input.preHandoffItems],
    newItems: [...commitItems],
    runContext: options.context,
  };
  const filtered = plan.filter ? plan.filter(input) : input;
  check();
  if (
    !filtered ||
    (typeof filtered.inputHistory !== 'string' &&
      !Array.isArray(filtered.inputHistory)) ||
    !Array.isArray(filtered.preHandoffItems) ||
    !Array.isArray(filtered.newItems)
  )
    throw new TypeError('Migration handoff filter must return history arrays');
  return { input: filtered, outputItem, transferMessage, commitItems };
}

/** @internal One captured Agent scope inside the fixed native capability ceiling. */
export type NativeHandoffAgent<
  Context,
  Output extends AgentOutputType = 'text',
> = {
  agent: Agent<Context, Output>;
  instructions: string;
  settings: ModelSettings;
  tools: readonly SerializedFunctionTool[];
};

function historyItems(input: HandoffInputData): AgentInputItem[] {
  const history: AgentInputItem[] = [
    ...(typeof input.inputHistory === 'string'
      ? [
          {
            type: 'message' as const,
            role: 'user' as const,
            content: input.inputHistory,
          },
        ]
      : input.inputHistory),
    ...input.preHandoffItems.map((item) => item.rawItem),
    ...input.newItems.map((item) => item.rawItem),
  ];
  const calls = new Map<string, string>();
  const finished = new Set<string>();
  for (const item of history) {
    if (item.type === 'function_call') {
      if (calls.has(item.callId))
        throw new TypeError(
          'Migration handoff history repeats a function call',
        );
      calls.set(item.callId, item.name);
    } else if (item.type === 'function_call_result') {
      if (calls.get(item.callId) !== item.name || finished.has(item.callId))
        throw new TypeError(
          'Migration handoff history requires paired function results',
        );
      finished.add(item.callId);
    } else if (item.type !== undefined && item.type !== 'message') {
      throw new TypeError(
        'Migration handoff history requires text and function items',
      );
    }
  }
  if (finished.size !== calls.size)
    throw new TypeError(
      'Migration handoff history has an incomplete function pair',
    );
  return history;
}

/** @internal A pending handoff becomes active only after a true native reply ACK. */
export class NativeHandoffState<
  Context,
  Output extends AgentOutputType = 'text',
> {
  private scope: NativeHandoffAgent<Context, Output>;
  private allowed: readonly SerializedFunctionTool[] = [];
  private readonly calls = new Map<
    string,
    {
      call: protocol.FunctionCallItem;
      agent: Agent<Context, Output>;
      responseIndex: number;
    }
  >();
  private preparing?: string;
  private pending?: {
    callId: string;
    responseIndex: number;
    prepared: PreparedNativeHandoff;
  };
  private transition?: {
    callId: string;
    responseIndex: number;
    prepared: PreparedNativeHandoff;
  };
  private targetStarted = false;

  constructor(
    readonly plan: CapturedNativeHandoff<Context, Output>,
    private readonly source: NativeHandoffAgent<Context, Output>,
    private readonly target: NativeHandoffAgent<Context, Output>,
    private readonly context: RunContext<Context>,
    private readonly input: string | AgentInputItem[],
    private readonly hooks: RunHooks<Context, Output> | undefined,
    private readonly records: {
      responses: readonly ModelResponse[];
      observations: (
        responses: readonly ModelResponse[],
      ) => MigrationObservation[];
      check: () => void;
      startTarget: (input: AgentInputItem[]) => void;
    },
  ) {
    this.scope = source;
  }

  get agent(): Agent<Context, Output> {
    return this.scope.agent;
  }
  get settings(): ModelSettings {
    return this.scope.settings;
  }

  get acceptedTransition(): AcceptedNativeHandoff | undefined {
    return this.transition;
  }
  get allowedTools(): readonly SerializedFunctionTool[] {
    return this.allowed;
  }

  check(): void {
    this.records.check();
    this.plan.check();
  }

  async request(request: ModelRequest): Promise<ModelRequest> {
    this.check();
    const enabled =
      this.scope === this.source && (await this.plan.enabled(this.context));
    this.check();
    let input = request.input;
    if (!Array.isArray(input))
      throw new TypeError('Migration handoff requires full native input');
    if (
      this.pending &&
      !this.transition &&
      input.some(
        (item) =>
          item.type === 'function_call_result' &&
          item.callId === this.pending!.callId,
      )
    )
      throw new TypeError(
        'Migration next request arrived before handoff acknowledgment',
      );
    if (this.transition) {
      const accepted = this.transition;
      const end = input.findIndex(
        (item) =>
          item.type === 'function_call_result' &&
          item.callId === accepted.callId,
      );
      if (
        end < 0 ||
        input.filter(
          (item) =>
            item.type === 'function_call_result' &&
            item.callId === accepted.callId,
        ).length !== 1
      )
        throw new TypeError(
          'Migration native history lost the accepted handoff pair',
        );
      input = [
        ...historyItems(accepted.prepared.input),
        ...input.slice(end + 1),
      ];
      if (!this.targetStarted) {
        this.targetStarted = true;
        this.records.startTarget(input);
        this.check();
      }
    }
    this.allowed = [
      ...this.scope.tools,
      ...(enabled ? [this.plan.declaration] : []),
    ];
    return {
      ...request,
      input,
      systemInstructions: this.scope.instructions,
      tools: structuredClone([...this.scope.tools]),
      handoffs: enabled ? [structuredClone(this.plan.serializedHandoff)] : [],
    };
  }

  validateResponse(response: ModelResponse): void {
    const calls = response.output.filter(
      (item) => item.type === 'function_call',
    );
    if (
      calls.some((call) => call.name === this.plan.declaration.name) &&
      calls.length !== 1
    )
      throw new TypeError(
        'Migration requires a handoff in its own function-call batch',
      );
  }

  observe(response: ModelResponse): void {
    for (const call of response.output) {
      if (call.type !== 'function_call') continue;
      if (
        this.calls.has(call.callId) ||
        !this.allowed.some((tool) => tool.name === call.name)
      )
        throw new TypeError(
          'Migration received a stale or nonadmitted Agent call',
        );
      this.calls.set(call.callId, {
        call,
        agent: this.agent,
        responseIndex: this.records.responses.indexOf(response),
      });
    }
  }

  assertTool(name: string, callId: string): void {
    this.check();
    const grant = this.calls.get(callId);
    if (!grant || grant.call.name !== name || grant.agent !== this.agent)
      throw new TypeError(
        'Migration tool is not admitted for the active Agent',
      );
  }

  async invoke(callId: string): Promise<string> {
    this.assertTool(this.plan.declaration.name, callId);
    if (this.scope !== this.source || this.preparing !== undefined)
      throw new TypeError('Migration handoff is no longer available');
    this.preparing = callId;
    const grant = this.calls.get(callId)!;
    const response = this.records.responses[grant.responseIndex]!;
    const itemAgent: RunHandoffOutputItem['sourceAgent'] = this.source.agent;
    const newItems = response.output.map((item) => {
      if (item.type === 'function_call')
        return new RunHandoffCallItem(structuredClone(item), itemAgent);
      if (
        (item.type === undefined || item.type === 'message') &&
        'role' in item &&
        item.role === 'assistant'
      )
        return new RunMessageOutputItem(structuredClone(item), itemAgent);
      throw new TypeError(
        'Migration handoff requires text and its transfer call',
      );
    });
    const prepared = await prepareNativeHandoff(this.plan, {
      context: this.context,
      call: grant.call,
      input: {
        inputHistory: this.input,
        preHandoffItems: migrationItems(
          this.source.agent,
          this.records.observations(
            this.records.responses.slice(0, grant.responseIndex),
          ),
        ),
        newItems,
        runContext: this.context,
      },
      hooks: this.hooks,
      check: () => this.records.check(),
    });
    historyItems(prepared.input);
    if (
      [...prepared.input.preHandoffItems, ...prepared.input.newItems].some(
        (item) =>
          ![
            'message_output_item',
            'tool_call_item',
            'tool_call_output_item',
            'handoff_call_item',
            'handoff_output_item',
          ].includes(item.type),
      )
    )
      throw new TypeError(
        'Migration handoff filter returned an unsupported item',
      );
    this.pending = { callId, responseIndex: grant.responseIndex, prepared };
    return prepared.transferMessage;
  }

  accepted(callId: string, name: string, response: ToolResponse): void {
    if (name !== this.plan.declaration.name) return;
    const pending = this.pending;
    const content = response.contentItems[0];
    if (
      !pending ||
      pending.callId !== callId ||
      this.transition ||
      !response.success ||
      response.contentItems.length !== 1 ||
      content?.type !== 'inputText' ||
      content.text !== pending.prepared.transferMessage
    )
      throw new TypeError(
        'Migration received an unmatched handoff acknowledgment',
      );
    // Acceptance remains a fact if cancellation arrives after the native ACK.
    this.transition = pending;
    this.pending = undefined;
    this.scope = this.target;
  }

  projection():
    { input: string | AgentInputItem[]; items: MigrationItem[] } | undefined {
    if (!this.transition) return undefined;
    const { prepared, responseIndex } = this.transition;
    const prior = [
      ...prepared.input.preHandoffItems,
      ...prepared.input.newItems,
    ];
    return {
      input: prepared.input.inputHistory,
      items: [
        ...(prior as MigrationItem[]),
        ...migrationItems(
          this.target.agent,
          this.records.observations(
            this.records.responses.slice(responseIndex + 1),
          ),
        ),
      ],
    };
  }
}
