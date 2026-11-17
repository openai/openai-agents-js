import { isDeepStrictEqual } from 'node:util';
import {
  getDefaultModelSettings,
  Usage,
  UserError,
  type AgentInputItem,
  type AssistantMessageItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelRetryAdvice,
  type StreamEvent,
} from '@openai/agents-core';
import {
  Codex,
  type CodexOptions,
  type ThreadOptions,
} from '@openai/codex-sdk';

export type CodexProviderOptions = {
  /** Options for the stock Codex SDK client, including its configuration and credentials. */
  codexOptions?: CodexOptions;
  /** Local workspace and permissions for each Codex thread. */
  threadOptions?: Omit<ThreadOptions, 'model'>;
};

/**
 * Experimental model provider for text turns backed by the stock Codex CLI.
 * Each model call starts a new Codex thread with its own tools and permissions.
 */
export class CodexProvider implements ModelProvider {
  constructor(private readonly options: CodexProviderOptions = {}) {}

  getModel(modelName?: string): Model {
    return new CodexModel(this.options, modelName || undefined);
  }
}

class CodexModel implements Model {
  constructor(
    private readonly options: CodexProviderOptions,
    private readonly modelName?: string,
  ) {}

  async getResponse(request: ModelRequest) {
    const { message, usage, responseId } = await this.runTurn(request);
    return { output: [message], usage, responseId };
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    const { message, text, usage, responseId } = await this.runTurn(request);
    yield { type: 'output_text_delta', delta: text, itemId: message.id };
    yield {
      type: 'response_done',
      response: { id: responseId, output: [message], usage },
    };
  }

  getRetryAdvice(): ModelRetryAdvice {
    // Codex may have already executed tools or changed files.
    return { replaySafety: 'unsafe' };
  }

  private async runTurn(request: ModelRequest) {
    this.validateRequest(request);
    const prompt = toCodexPrompt(request.input);
    request.signal?.throwIfAborted();

    const options = this.options.codexOptions;
    const codex = new Codex({
      ...options,
      configOverrides: request.systemInstructions
        ? [
            ...(options?.configOverrides ?? []),
            `developer_instructions=${JSON.stringify(request.systemInstructions)}`,
          ]
        : options?.configOverrides,
    });
    const thread = codex.startThread({
      ...this.options.threadOptions,
      model: this.modelName,
    });
    const turn = await thread.run(prompt, { signal: request.signal });
    request.signal?.throwIfAborted();

    const finalMessage = turn.items
      .filter((item) => item.type === 'agent_message')
      .at(-1);
    if (!thread.id || !finalMessage) {
      throw new Error('Codex finished without a final assistant message.');
    }

    const message: AssistantMessageItem = {
      id: finalMessage.id,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: turn.finalResponse }],
    };
    const usage = new Usage(
      turn.usage
        ? {
            inputTokens: turn.usage.input_tokens,
            outputTokens: turn.usage.output_tokens,
            inputTokensDetails: {
              cached_tokens: turn.usage.cached_input_tokens ?? 0,
              cache_write_tokens: turn.usage.cache_write_input_tokens ?? 0,
            },
            outputTokensDetails: {
              reasoning_tokens: turn.usage.reasoning_output_tokens ?? 0,
            },
          }
        : {},
    );
    return { message, text: turn.finalResponse, usage, responseId: thread.id };
  }

  private validateRequest(request: ModelRequest) {
    if (
      request.tools.length ||
      request.handoffs.length ||
      request.outputType !== 'text'
    ) {
      throw new UserError(
        'CodexProvider supports text output without Agents SDK tools or handoffs.',
      );
    }
    if (
      request.previousResponseId !== undefined ||
      request.conversationId !== undefined ||
      request.prompt !== undefined
    ) {
      throw new UserError(
        'CodexProvider does not support Responses API state or prompt IDs.',
      );
    }

    // The Runner can add OpenAI model defaults even for a custom provider.
    const { timeoutMs: _timeoutMs, ...settings } = request.modelSettings;
    const defaults = getDefaultModelSettings(this.modelName);
    for (const key of Object.keys(settings) as (keyof typeof settings)[]) {
      if (
        settings[key] !== undefined &&
        !isDeepStrictEqual(settings[key], defaults[key])
      ) {
        throw new UserError(
          `CodexProvider does not support modelSettings.${key}. Configure Codex through CodexProvider options.`,
        );
      }
    }
  }
}

function toCodexPrompt(input: string | AgentInputItem[]): string {
  const messages =
    typeof input === 'string'
      ? [{ role: 'user', text: input }]
      : input.map((item) => {
          if (
            (item.type !== 'message' && item.type !== undefined) ||
            !('role' in item) ||
            (item.role !== 'user' && item.role !== 'assistant')
          ) {
            throw new UserError(
              'CodexProvider accepts only user and assistant text messages.',
            );
          }

          const text =
            typeof item.content === 'string'
              ? item.content
              : item.content
                  .map((part) => {
                    if (
                      part.type !== 'input_text' &&
                      part.type !== 'output_text'
                    ) {
                      throw new UserError(
                        'CodexProvider accepts only user and assistant text messages.',
                      );
                    }
                    return part.text;
                  })
                  .join('\n');
          return { role: item.role, text };
        });

  const latest = messages.at(-1);
  if (latest?.role !== 'user' || !latest.text.trim()) {
    throw new UserError(
      'CodexProvider requires a final user message with text.',
    );
  }
  if (messages.length === 1) {
    return latest.text;
  }
  return `Prior conversation (JSON):\n${JSON.stringify(messages.slice(0, -1))}\n\nLatest user message:\n${latest.text}`;
}
