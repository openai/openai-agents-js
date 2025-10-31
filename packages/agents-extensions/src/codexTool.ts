import {
  createCustomSpan,
  CustomSpanData,
  FunctionTool,
  JsonObjectSchemaStrict,
  RunContext,
  Span,
  Usage,
  UserError,
} from '@openai/agents';
import {
  Codex,
  CodexOptions,
  CommandExecutionItem,
  McpToolCallItem,
  ReasoningItem,
  RunStreamedResult,
  SandboxMode,
  Thread,
  ThreadItem,
  ThreadOptions,
  TurnOptions,
  Usage as CodexUsage,
  UserInput,
} from '@openai/codex-sdk';

type CustomSpan = Span<CustomSpanData>;

type CodexToolCallArguments = {
  task: string;
  inputs?: UserInput[];
  threadId?: string;
  outputSchema?: unknown;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
};

type CodexToolOptions = {
  /**
   * Name of the tool as exposed to the agent model.
   *
   * @defaultValue `'codex'`
   */
  name?: string;
  /**
   * Description surfaced to the agent model.
   */
  description?: string;
  /**
   * Explicit parameter schema. When omitted, the default schema is used.
   */
  parameters?: JsonObjectSchemaStrict<{
    task: { type: 'string'; description: string };
    thread_id: { type: 'string'; description: string };
    output_schema: { type: 'object'; description: string };
    sandbox_mode: {
      type: 'string';
      enum: ['read-only', 'workspace-write', 'danger-full-access'];
      description: string;
    };
    working_directory: { type: 'string'; description: string };
    skip_git_repo_check: { type: 'boolean'; description: string };
    inputs: {
      type: 'array';
      description: string;
      items: {
        oneOf: [
          {
            type: 'object';
            properties: {
              type: { const: 'text' };
              text: { type: 'string'; description: string };
            };
            required: ['type', 'text'];
            additionalProperties: false;
          },
          {
            type: 'object';
            properties: {
              type: { const: 'local_image' };
              path: { type: 'string'; description: string };
            };
            required: ['type', 'path'];
            additionalProperties: false;
          },
        ];
      };
    };
  }>;
  /**
   * Reuse an existing Codex instance. When omitted a new Codex instance will be created.
   */
  codex?: Codex;
  /**
   * Options passed to the Codex constructor when {@link CodexToolOptions.codex} is undefined.
   */
  codexOptions?: CodexOptions;
  /**
   * Default options applied to every Codex thread.
   */
  defaultThreadOptions?: ThreadOptions;
  /**
   * Default options applied to every Codex turn.
   */
  defaultTurnOptions?: TurnOptions;
};

const defaultParameters: NonNullable<CodexToolOptions['parameters']> = {
  type: 'object',
  additionalProperties: false,
  required: ['task'],
  properties: {
    task: {
      type: 'string',
      description:
        'Detailed instruction for the Codex agent. This should include enough context for the agent to act.',
    },
    thread_id: {
      type: 'string',
      description:
        'Resume an existing Codex thread by id. Omit to start a fresh thread for this tool call.',
    },
    output_schema: {
      type: 'object',
      description:
        'Optional JSON schema that Codex should satisfy when producing its final answer. The schema must be compatible with OpenAI JSON schema format.',
    },
    sandbox_mode: {
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
      description:
        'Sandbox permissions for the Codex task. Defaults to Codex CLI defaults if omitted.',
    },
    working_directory: {
      type: 'string',
      description:
        'Absolute path used as the working directory for the Codex thread. Defaults to the current process working directory.',
    },
    skip_git_repo_check: {
      type: 'boolean',
      description:
        'Set to true to allow Codex to run outside a Git repository. By default Codex requires a Git workspace.',
    },
    inputs: {
      type: 'array',
      description:
        'Optional structured inputs appended after the task. Supports additional text snippets and local images.',
      items: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: { const: 'text' },
              text: {
                type: 'string',
                description: 'Additional text provided to the Codex task.',
              },
            },
            required: ['type', 'text'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              type: { const: 'local_image' },
              path: {
                type: 'string',
                description: 'Absolute or relative path to the image on disk.',
              },
            },
            required: ['type', 'path'],
            additionalProperties: false,
          },
        ],
      },
    },
  },
};

/**
 * Wraps the Codex SDK in a function tool that can be consumed by the Agents SDK.
 *
 * The tool streams Codex events, creating child spans for reasoning items, command executions,
 * and MCP tool invocations. Those spans are nested under the Codex tool span automatically when
 * tracing is enabled.
 */
export function codexTool(options: CodexToolOptions = {}): FunctionTool {
  const {
    name = 'codex',
    description = 'Executes an agentic Codex task against the current workspace.',
    parameters = defaultParameters,
    codex: providedCodex,
    codexOptions,
    defaultThreadOptions,
    defaultTurnOptions,
  } = options;

  const codexInstance = providedCodex ?? new Codex(codexOptions);

  return {
    type: 'function',
    name,
    description,
    parameters,
    strict: true,
    needsApproval: async () => false,
    isEnabled: async () => true,
    invoke: async (
      runContext: RunContext,
      rawInput: string,
    ): Promise<{
      threadId: string | null;
      response: string;
      usage: CodexUsage | null;
    }> => {
      const args = parseArguments(rawInput);

      const thread = getThread(codexInstance, args, defaultThreadOptions);
      const turnOptions = buildTurnOptions(args, defaultTurnOptions);
      const codexInput = buildCodexInput(args);

      const streamResult = await thread.runStreamed(codexInput, turnOptions);

      const { response, usage } = await consumeEvents(streamResult, args);

      if (usage) {
        runContext.usage.add(
          new Usage({
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.input_tokens + usage.output_tokens,
            requests: 1,
          }),
        );
      }

      return {
        threadId: thread.id,
        response,
        usage,
      };
    },
  };
}

function buildTurnOptions(
  args: CodexToolCallArguments,
  defaults?: TurnOptions,
): TurnOptions | undefined {
  const hasOverrides = typeof args.outputSchema !== 'undefined';
  if (!defaults && !hasOverrides) {
    return undefined;
  }

  return {
    ...(defaults ?? {}),
    ...(hasOverrides ? { outputSchema: args.outputSchema } : {}),
  };
}

function getThread(
  codex: Codex,
  args: CodexToolCallArguments,
  defaults?: ThreadOptions,
): Thread {
  const hasOverrides =
    typeof args.sandboxMode !== 'undefined' ||
    typeof args.workingDirectory === 'string' ||
    typeof args.skipGitRepoCheck === 'boolean';

  const threadOptions: ThreadOptions | undefined =
    defaults || hasOverrides
      ? {
          ...(defaults ?? {}),
          ...(args.sandboxMode ? { sandboxMode: args.sandboxMode } : {}),
          ...(args.workingDirectory
            ? { workingDirectory: args.workingDirectory }
            : {}),
          ...(typeof args.skipGitRepoCheck === 'boolean'
            ? { skipGitRepoCheck: args.skipGitRepoCheck }
            : {}),
        }
      : undefined;

  if (args.threadId) {
    return codex.resumeThread(args.threadId, threadOptions);
  }
  return codex.startThread(threadOptions);
}

function buildCodexInput(args: CodexToolCallArguments): string | UserInput[] {
  if (args.inputs && args.inputs.length > 0) {
    const base: UserInput[] = args.task.trim().length
      ? [{ type: 'text', text: args.task }]
      : [];
    return base.concat(args.inputs);
  }
  return args.task;
}

async function consumeEvents(
  { events }: RunStreamedResult,
  args: CodexToolCallArguments,
): Promise<{ response: string; usage: CodexUsage | null }> {
  const activeSpans = new Map<string, CustomSpan>();
  let finalResponse = '';
  let usage: CodexUsage | null = null;

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'item.started':
          handleItemStarted(event.item, activeSpans);
          break;
        case 'item.updated':
          handleItemUpdated(event.item, activeSpans);
          break;
        case 'item.completed':
          handleItemCompleted(event.item, activeSpans);
          if (
            event.item.type === 'agent_message' &&
            typeof event.item.text === 'string'
          ) {
            finalResponse = event.item.text;
          }
          break;
        case 'turn.completed':
          usage = event.usage ?? null;
          break;
        case 'turn.failed':
          throw new UserError(
            `Codex turn failed${event.error?.message ? `: ${event.error.message}` : ''}`,
          );
        case 'error':
          throw new UserError(`Codex stream error: ${event.message}`);
        default:
          // ignore other events
          break;
      }
    }
  } finally {
    for (const span of activeSpans.values()) {
      span.end();
    }
    activeSpans.clear();
  }

  if (!finalResponse) {
    finalResponse = buildDefaultResponse(args);
  }

  return { response: finalResponse, usage };
}

function handleItemStarted(item: ThreadItem, spans: Map<string, CustomSpan>) {
  if (isCommandExecutionItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex command execution',
        data: {
          command: item.command,
          status: item.status,
          output: item.aggregated_output ?? '',
          exitCode: item.exit_code ?? null,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isMcpToolCallItem(item)) {
    const span = createCustomSpan({
      data: {
        name: `Codex MCP tool call`,
        data: {
          server: item.server,
          tool: item.tool,
          status: item.status,
          arguments: item.arguments ?? null,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
    return;
  }

  if (isReasoningItem(item)) {
    const span = createCustomSpan({
      data: {
        name: 'Codex reasoning',
        data: {
          text: item.text,
        },
      },
    });
    span.start();
    spans.set(item.id, span);
  }
}

function handleItemUpdated(item: ThreadItem, spans: Map<string, CustomSpan>) {
  const span = item.id ? spans.get(item.id) : undefined;
  if (!span) {
    return;
  }

  if (isCommandExecutionItem(item)) {
    updateCommandSpan(span, item);
  } else if (isMcpToolCallItem(item)) {
    updateMcpToolSpan(span, item);
  } else if (isReasoningItem(item)) {
    updateReasoningSpan(span, item);
  }
}

function handleItemCompleted(item: ThreadItem, spans: Map<string, CustomSpan>) {
  const span = item.id ? spans.get(item.id) : undefined;
  if (!span) {
    return;
  }

  if (isCommandExecutionItem(item)) {
    updateCommandSpan(span, item);
    if (item.status === 'failed') {
      span.setError({
        message: 'Codex command execution failed.',
        data: {
          exitCode: item.exit_code ?? null,
          output: item.aggregated_output ?? '',
        },
      });
    }
  } else if (isMcpToolCallItem(item)) {
    updateMcpToolSpan(span, item);
    if (item.status === 'failed' && item.error?.message) {
      span.setError({
        message: item.error.message,
      });
    }
  } else if (isReasoningItem(item)) {
    updateReasoningSpan(span, item);
  }

  span.end();
  spans.delete(item.id);
}

function updateCommandSpan(span: CustomSpan, item: CommandExecutionItem) {
  const data = span.spanData.data;
  data.command = item.command;
  data.status = item.status;
  data.output = item.aggregated_output ?? '';
  data.exitCode = item.exit_code ?? null;
}

function updateMcpToolSpan(span: CustomSpan, item: McpToolCallItem) {
  const data = span.spanData.data;
  data.server = item.server;
  data.tool = item.tool;
  data.status = item.status;
  data.arguments = item.arguments ?? null;
  data.result = item.result ?? null;
  data.error = item.error ?? null;
}

function updateReasoningSpan(span: CustomSpan, item: ReasoningItem) {
  const data = span.spanData.data;
  data.text = item.text;
}

function parseArguments(rawInput: string): CodexToolCallArguments {
  let parsed: any;
  try {
    parsed = rawInput ? JSON.parse(rawInput) : {};
  } catch (_error) {
    throw new UserError('Codex tool arguments must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserError(
      'Codex tool arguments must be provided as a JSON object.',
    );
  }

  const task = typeof parsed.task === 'string' ? parsed.task.trim() : '';
  if (!task) {
    throw new UserError('Codex tool requires a non-empty "task" string.');
  }

  const inputs = parseInputs(parsed.inputs);

  return {
    task,
    inputs,
    threadId:
      typeof parsed.thread_id === 'string' && parsed.thread_id.length > 0
        ? parsed.thread_id
        : typeof parsed.threadId === 'string' && parsed.threadId.length > 0
          ? parsed.threadId
          : undefined,
    outputSchema: parsed.output_schema ?? parsed.outputSchema,
    sandboxMode: isSandboxMode(parsed.sandbox_mode ?? parsed.sandboxMode)
      ? (parsed.sandbox_mode ?? parsed.sandboxMode)
      : undefined,
    workingDirectory:
      typeof parsed.working_directory === 'string' &&
      parsed.working_directory.length > 0
        ? parsed.working_directory
        : typeof parsed.workingDirectory === 'string' &&
            parsed.workingDirectory.length > 0
          ? parsed.workingDirectory
          : undefined,
    skipGitRepoCheck:
      typeof parsed.skip_git_repo_check === 'boolean'
        ? parsed.skip_git_repo_check
        : typeof parsed.skipGitRepoCheck === 'boolean'
          ? parsed.skipGitRepoCheck
          : undefined,
  };
}

function parseInputs(value: unknown): UserInput[] | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new UserError(
      'The "inputs" property must be an array when provided.',
    );
  }

  const inputs: UserInput[] = value.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw new UserError('Each item in "inputs" must be an object.');
    }
    const typed = entry as Record<string, unknown>;
    if (typed.type === 'text' && typeof typed.text === 'string') {
      return { type: 'text', text: typed.text };
    }
    if (typed.type === 'local_image' && typeof typed.path === 'string') {
      return { type: 'local_image', path: typed.path };
    }
    throw new UserError(
      'Inputs must either be { "type": "text", "text": string } or { "type": "local_image", "path": string }.',
    );
  });

  return inputs.length === 0 ? undefined : inputs;
}

function buildDefaultResponse(args: CodexToolCallArguments): string {
  return `Codex task completed for "${args.task}".`;
}

function isSandboxMode(value: unknown): value is SandboxMode {
  return (
    value === 'read-only' ||
    value === 'workspace-write' ||
    value === 'danger-full-access'
  );
}

function isCommandExecutionItem(
  item: ThreadItem,
): item is CommandExecutionItem {
  return item?.type === 'command_execution';
}

function isMcpToolCallItem(item: ThreadItem): item is McpToolCallItem {
  return item?.type === 'mcp_tool_call';
}

function isReasoningItem(item: ThreadItem): item is ReasoningItem {
  return item?.type === 'reasoning';
}
