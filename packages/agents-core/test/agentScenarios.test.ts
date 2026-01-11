import {
  describe,
  it,
  expect,
  beforeEach,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AgentInputItem,
  FunctionToolResult,
  InputGuardrailTripwireTriggered,
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelSettings,
  RunAgentUpdatedStreamEvent,
  RunContext,
  RunStreamEvent,
  ToolUseBehavior,
  ToolsToFinalOutputResult,
  Usage,
  OutputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  handoff,
  run,
  tool,
  hostedMcpTool,
  setDefaultModelProvider,
  Runner,
  MemorySession,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
  shellTool,
  applyPatchTool,
} from '../src';
import { getDefaultModelProvider } from '../src/providers';
import { user } from '../src/helpers/message';
import * as protocol from '../src/types/protocol';
import logger from '../src/logger';

/**
 * Fake model for scenario-style tests. It queues per-turn outputs (or errors),
 * records the request args, and can emit streaming events including text deltas
 * and a final response_done event.
 */
class RecordingModel implements Model {
  #turnOutputs: Array<ModelResponse | ModelResponse['output'] | Error> = [];
  #hardcodedUsage: Usage | undefined;
  public lastTurnArgs: Partial<ModelRequest> | undefined;
  public firstTurnArgs: Partial<ModelRequest> | undefined;
  public calls: Partial<ModelRequest>[] = [];
  #responseCounter = 0;

  constructor(initial?: ModelResponse | ModelResponse['output'] | Error) {
    if (initial) {
      this.#turnOutputs.push(initial);
    }
  }

  setHardcodedUsage(usage: Usage) {
    this.#hardcodedUsage = usage;
  }

  setNextOutput(output: ModelResponse | ModelResponse['output'] | Error) {
    this.#turnOutputs.push(output);
  }

  addMultipleTurnOutputs(
    outputs: Array<ModelResponse | ModelResponse['output'] | Error>,
  ) {
    this.#turnOutputs.push(...outputs);
  }

  #getNextOutput(): ModelResponse | ModelResponse['output'] | Error {
    if (this.#turnOutputs.length === 0) {
      throw new Error('No queued output');
    }
    return this.#turnOutputs.shift() as
      | ModelResponse
      | ModelResponse['output']
      | Error;
  }

  #recordArgs(request: ModelRequest) {
    const recordedArgs: Partial<ModelRequest> = {
      systemInstructions: request.systemInstructions,
      input: request.input,
      modelSettings: request.modelSettings,
      tools: request.tools,
      outputType: request.outputType,
      handoffs: request.handoffs,
      previousResponseId: request.previousResponseId,
      conversationId: request.conversationId,
      prompt: request.prompt,
      overridePromptModel: request.overridePromptModel,
    };
    this.lastTurnArgs = recordedArgs;
    this.calls.push(recordedArgs);
    if (!this.firstTurnArgs) {
      this.firstTurnArgs = this.lastTurnArgs;
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.#recordArgs(request);
    const output = this.#getNextOutput();
    if (output instanceof Error) {
      throw output;
    }
    const { normalizedOutput, usage, responseId } = normalizeTurnOutput(
      output,
      this.#hardcodedUsage,
    );
    const finalResponseId = responseId ?? `resp-${++this.#responseCounter}`;
    if (responseId) {
      this.#responseCounter += 1;
    }
    return { output: normalizedOutput, usage, responseId: finalResponseId };
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<protocol.StreamEvent> {
    this.#recordArgs(request);
    const output = this.#getNextOutput();
    if (output instanceof Error) {
      throw output;
    }
    const { normalizedOutput, usage, responseId } = normalizeTurnOutput(
      output,
      this.#hardcodedUsage,
    );
    const finalResponseId =
      responseId ?? `resp-stream-${++this.#responseCounter}`;
    if (responseId) {
      this.#responseCounter += 1;
    }

    const signal = request.signal;

    const throwIfAborted = () => {
      if (signal?.aborted) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
    };

    throwIfAborted();

    yield* streamFromOutput(normalizedOutput, throwIfAborted);

    throwIfAborted();

    yield {
      type: 'response_done',
      response: {
        id: finalResponseId,
        usage: {
          requests: usage.requests,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          inputTokensDetails: usage.inputTokensDetails,
          outputTokensDetails: usage.outputTokensDetails,
        },
        output: normalizedOutput,
      },
    } as protocol.StreamEvent;
  }
}

function normalizeTurnOutput(
  turn: ModelResponse | ModelResponse['output'],
  hardcodedUsage: Usage | undefined,
): {
  normalizedOutput: ModelResponse['output'];
  usage: Usage;
  responseId?: string;
} {
  const responseLike = turn as Partial<ModelResponse>;
  const normalizedOutput = (responseLike.output ??
    turn) as ModelResponse['output'];
  const usage =
    hardcodedUsage !== undefined
      ? new Usage(hardcodedUsage)
      : responseLike.usage
        ? new Usage(responseLike.usage)
        : new Usage();
  return { normalizedOutput, usage, responseId: responseLike.responseId };
}

async function* streamFromOutput(
  output: ModelResponse['output'],
  throwIfAborted: () => void,
): AsyncIterable<protocol.StreamEvent> {
  for (const item of output) {
    throwIfAborted();
    if (item.type !== 'message') {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (part.type === 'output_text') {
        yield {
          type: 'output_text_delta',
          delta: part.text,
        } as protocol.StreamEvent;
      }
    }
  }
}

/**
 * Helper that returns a function-call item referencing a handoff tool.
 */
function handoffToolCall(
  agent: Agent<any, any>,
  args?: string,
): protocol.FunctionCallItem {
  const h = handoff(agent);
  return functionToolCall(h.toolName, args);
}

function functionToolCall(
  name: string,
  args?: string,
  callId?: string,
): protocol.FunctionCallItem {
  return {
    id: `fc_${callId ?? '1'}`,
    type: 'function_call',
    name,
    callId: callId ?? 'call_1',
    status: 'completed',
    arguments: args ?? '',
    providerData: {},
  };
}

function hostedToolCall(
  name: string,
  args?: string,
  output?: string,
): protocol.HostedToolCallItem {
  return {
    id: `htc_${name}`,
    type: 'hosted_tool_call',
    name,
    status: 'completed',
    arguments: args,
    output,
    providerData: {
      type: 'mcp_call',
      server_label: 'gitmcp',
      name,
      id: `htc_${name}`,
      arguments: args,
    },
  };
}

function textMessage(content: string): protocol.AssistantMessageItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text: content,
        providerData: { annotations: [] },
      },
    ],
    providerData: {},
  };
}

function finalOutputMessage(content: string): protocol.AssistantMessageItem {
  return textMessage(content);
}

function shellCall(
  action: protocol.ShellAction,
  callId?: string,
): protocol.ShellCallItem {
  return {
    id: `shell_${callId ?? '1'}`,
    type: 'shell_call',
    callId: callId ?? 'shell_call_1',
    action,
    status: 'completed',
    providerData: {},
  };
}

function applyPatchCall(
  operation: protocol.ApplyPatchOperation,
  callId?: string,
): protocol.ApplyPatchCallItem {
  return {
    id: `ap_${callId ?? '1'}`,
    type: 'apply_patch_call',
    callId: callId ?? 'ap1',
    status: 'completed',
    operation,
    providerData: {},
  };
}

function extractUserText(
  input: ModelRequest['input'] | undefined,
): string | undefined {
  if (typeof input === 'string') {
    return input;
  }
  const first = Array.isArray(input) ? input[0] : undefined;
  if (!first || first.type !== 'message' || first.role !== 'user') {
    return undefined;
  }
  if (typeof first.content === 'string') {
    return first.content;
  }
  if (Array.isArray(first.content)) {
    const content = first.content[0] as protocol.InputText | undefined;
    if (content && content.type === 'input_text') {
      return content.text;
    }
  }
  return undefined;
}

describe('Agent scenarios (examples and docs patterns)', () => {
  let previousDefaultProvider: ModelProvider | undefined;

  beforeAll(() => {
    try {
      previousDefaultProvider = getDefaultModelProvider();
    } catch {
      previousDefaultProvider = undefined;
    }

    class DummyProvider implements ModelProvider {
      async getModel(): Promise<Model> {
        throw new Error(
          'Default model provider should not be used in these tests',
        );
      }
    }
    setDefaultModelProvider(new DummyProvider());
  });

  afterAll(() => {
    if (previousDefaultProvider) {
      setDefaultModelProvider(previousDefaultProvider);
    }
  });

  beforeEach(() => {
    // Ensure tracing stays disabled for these fake-model tests.
    // helpers/tests/setup.ts already calls setTracingDisabled(true) globally.
  });

  it('loops until evaluator passes the outline (llm_as_judge)', async () => {
    const outlineModel = new RecordingModel();
    outlineModel.addMultipleTurnOutputs([
      [textMessage('Outline v1')],
      [textMessage('Outline v2')],
    ]);

    const judgeModel = new RecordingModel();
    judgeModel.addMultipleTurnOutputs([
      [
        finalOutputMessage(
          JSON.stringify({
            feedback: 'Add more suspense',
            score: 'needs_improvement',
          }),
        ),
      ],
      [
        finalOutputMessage(
          JSON.stringify({ feedback: 'Looks good', score: 'pass' }),
        ),
      ],
    ]);

    const evaluationOutput = z.object({
      feedback: z.string(),
      score: z.enum(['pass', 'needs_improvement']),
    });

    const outlineAgent = new Agent({ name: 'outline', model: outlineModel });
    const judgeAgent = new Agent({
      name: 'judge',
      model: judgeModel,
      outputType: evaluationOutput,
    });

    let conversation: AgentInputItem[] = [user('Tell me a space story')];
    let latestOutline: string | undefined;

    for (const [expectedOutline, expectedScore] of [
      ['Outline v1', 'needs_improvement'] as const,
      ['Outline v2', 'pass'] as const,
    ]) {
      const outlineResult = await run(outlineAgent, conversation);
      latestOutline = outlineResult.finalOutput;
      expect(latestOutline).toBe(expectedOutline);

      conversation = outlineResult.history;

      const judgeResult = await run(judgeAgent, conversation);
      const feedback = judgeResult.finalOutput;
      expect(feedback).toBeDefined();
      expect(feedback?.score).toBe(expectedScore);

      if (feedback?.score === 'pass') {
        break;
      }

      conversation.push(user(`Feedback: ${feedback?.feedback}`));
    }

    expect(latestOutline).toBe('Outline v2');
    expect(conversation.length).toBeGreaterThanOrEqual(2);
    expect(judgeModel.lastTurnArgs?.input).toEqual(conversation);
  });

  it('returns simple text output for a single-turn agent', async () => {
    const model = new RecordingModel([textMessage('Hello from agent')]);
    const agent = new Agent({ name: 'simple', model });

    const result = await run(agent, 'Hi');

    expect(result.finalOutput).toBe('Hello from agent');
    expect(result.rawResponses.length).toBe(1);
    expect(result.history.length).toBe(2);
  });

  it('surfaces tool approval interruptions when a tool needs approval', async () => {
    let executed = 0;
    const needsApprovalTool = tool({
      name: 'secure_tool',
      description: 'A tool that needs approval',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => {
        executed += 1;
        return 'should not run';
      },
    });

    const model = new RecordingModel([functionToolCall('secure_tool', '{}')]);

    const agent = new Agent({
      name: 'approvals',
      model,
      tools: [needsApprovalTool],
      modelSettings: { toolChoice: 'required' },
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await run(agent, 'run the secure tool');

    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
    expect(result.interruptions?.length).toBe(1);
    expect(result.interruptions?.[0].name).toBe('secure_tool');
    expect(executed).toBe(0);

    warnSpy.mockRestore();
  });

  it('applies callModelInputFilter edits before calling the model', async () => {
    const model = new RecordingModel([textMessage('Filtered response')]);
    const agent = new Agent({ name: 'filtered', model });

    const result = await run(agent, 'Sensitive input', {
      callModelInputFilter: ({ modelData: _modelData }) => {
        return {
          instructions: 'Filtered instructions',
          input: [user('Redacted')],
        };
      },
    });

    expect(result.finalOutput).toBe('Filtered response');
    expect(model.lastTurnArgs?.systemInstructions).toBe(
      'Filtered instructions',
    );
    expect(extractUserText(model.lastTurnArgs?.input)).toBe('Redacted');
  });

  it('passes conversation identifiers through to the model request', async () => {
    const model = new RecordingModel([textMessage('Hello')]);
    const agent = new Agent({ name: 'conv', model });

    const result = await run(agent, 'Hi', {
      conversationId: 'conv-123',
      previousResponseId: 'prev-456',
    });

    expect(result.finalOutput).toBe('Hello');
    expect(model.lastTurnArgs?.conversationId).toBe('conv-123');
    expect(model.lastTurnArgs?.previousResponseId).toBe('prev-456');
  });

  it('replays session history across runs using MemorySession', async () => {
    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [textMessage('First reply')],
      [textMessage('Second reply')],
    ]);

    const agent = new Agent({ name: 'sessioned', model });
    const session = new MemorySession();

    const first = await run(agent, 'Hello session', { session });
    expect(first.finalOutput).toBe('First reply');
    const storedAfterFirst = await session.getItems();
    expect(storedAfterFirst.length).toBe(2);

    const second = await run(agent, 'Follow up', { session });
    expect(second.finalOutput).toBe('Second reply');

    const secondInput = model.calls[1]?.input;
    expect(Array.isArray(secondInput)).toBe(true);
    if (Array.isArray(secondInput)) {
      const assistantMessages = secondInput.filter(
        (item): item is protocol.AssistantMessageItem =>
          item.type === 'message' && item.role === 'assistant',
      );
      expect(
        assistantMessages.some((msg) => {
          const content = Array.isArray(msg.content)
            ? msg.content[0]
            : undefined;
          return (
            content && (content as protocol.OutputText).text === 'First reply'
          );
        }),
      ).toBe(true);

      const userMessages = secondInput.filter(
        (item): item is protocol.UserMessageItem =>
          item.type === 'message' && item.role === 'user',
      );
      expect(
        extractUserText([
          userMessages[userMessages.length - 1],
        ] as ModelRequest['input']),
      ).toBe('Follow up');
    }

    const storedAfterSecond = await session.getItems();
    const userCount = storedAfterSecond.filter(
      (item): item is protocol.UserMessageItem =>
        item.type === 'message' && item.role === 'user',
    ).length;
    const assistantCount = storedAfterSecond.filter(
      (item): item is protocol.AssistantMessageItem =>
        item.type === 'message' && item.role === 'assistant',
    ).length;
    expect(userCount).toBe(2);
    expect(assistantCount).toBe(2);
  });

  it('resumes with previousResponseId and only sends new user input', async () => {
    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      {
        output: [textMessage('First turn')],
        usage: new Usage(),
        responseId: 'resp-100',
      },
      [textMessage('Second turn')],
    ]);

    const agent = new Agent({ name: 'prev-response', model });

    const first = await run(agent, 'Initial', {
      previousResponseId: 'seed-resp',
    });
    expect(first.finalOutput).toBe('First turn');
    expect(model.calls[0]?.previousResponseId).toBe('seed-resp');

    const followUp = await run(agent, 'Follow up', {
      previousResponseId: first.rawResponses[0]?.responseId,
    });
    expect(followUp.finalOutput).toBe('Second turn');
    expect(model.calls[1]?.previousResponseId).toBe('resp-100');

    const secondInput = model.calls[1]?.input;
    expect(Array.isArray(secondInput)).toBe(true);
    if (Array.isArray(secondInput)) {
      expect(secondInput.length).toBe(1);
      expect(extractUserText(secondInput)).toBe('Follow up');
    }
  });

  it('applies callModelInputFilter even when server manages conversation state', async () => {
    const model = new RecordingModel([textMessage('hi there')]);
    const agent = new Agent({ name: 'filtered-server', model });

    const history: AgentInputItem[] = [
      user('keep me'),
      textMessage('assistant reply'),
      user('redact me'),
    ];

    const result = await run(agent, history, {
      conversationId: 'conv-filter',
      callModelInputFilter: ({ modelData }) => ({
        ...modelData,
        input: modelData.input.filter(
          (item) => item.type === 'message' && item.role === 'user',
        ),
      }),
    });

    expect(result.finalOutput).toBe('hi there');
    expect(Array.isArray(model.lastTurnArgs?.input)).toBe(true);
    if (Array.isArray(model.lastTurnArgs?.input)) {
      const userOnly = model.lastTurnArgs?.input.filter(
        (item) => item.type === 'message' && item.role === 'user',
      );
      expect(userOnly.length).toBe(2);
      expect(extractUserText(userOnly)).toBe('keep me');
    }
    expect(model.lastTurnArgs?.conversationId).toBe('conv-filter');
  });

  it('sends prompt templates and overrides prompt model when a custom model is set', async () => {
    const model = new RecordingModel([textMessage('Hello Kaz')]);
    const agent = new Agent({
      name: 'prompted',
      model,
      instructions: 'Be concise',
      prompt: {
        promptId: 'pmpt_template_123',
        version: 'v2',
        variables: {
          name: 'Kaz',
          greeting: { type: 'input_text', text: 'Howdy' },
        },
      },
    });

    const result = await run(agent, 'What is your name?');

    expect(result.finalOutput).toBe('Hello Kaz');
    expect(model.lastTurnArgs?.prompt).toMatchObject({
      promptId: 'pmpt_template_123',
      version: 'v2',
      variables: {
        name: 'Kaz',
        greeting: { type: 'input_text', text: 'Howdy' },
      },
    });
    expect(model.lastTurnArgs?.overridePromptModel).toBe(true);
    expect(model.lastTurnArgs?.systemInstructions).toBe('Be concise');
  });

  it('runs a basic tool call and uses the tool output', async () => {
    let toolCalls = 0;
    const adder = tool({
      name: 'add',
      description: 'Adds two numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => {
        toolCalls += 1;
        return a + b;
      },
    });

    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [functionToolCall('add', JSON.stringify({ a: 2, b: 3 }))],
      [textMessage('sum is 5')],
    ]);

    const agent = new Agent({
      name: 'calculator',
      model,
      tools: [adder],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'Add 2 and 3');

    expect(toolCalls).toBe(1);
    expect(result.finalOutput).toBe('sum is 5');
    expect(result.rawResponses.length).toBe(2);
  });

  it('reuses outputs across parallel translations', async () => {
    const translationModel = new RecordingModel();
    translationModel.addMultipleTurnOutputs([
      [textMessage('Uno')],
      [textMessage('Dos')],
      [textMessage('Tres')],
    ]);
    const spanishAgent = new Agent({
      name: 'spanish_agent',
      model: translationModel,
    });

    const pickerModel = new RecordingModel();
    pickerModel.setNextOutput([textMessage('Pick: Dos')]);
    const pickerAgent = new Agent({ name: 'picker', model: pickerModel });

    const translationResults = await Promise.all(
      Array.from({ length: 3 }).map(() => run(spanishAgent, 'Hello')),
    );
    const translations = translationResults.map(
      (result) => result.finalOutput ?? '',
    );

    const combined = translations.join('\n\n');
    const pickerResult = await run(
      pickerAgent,
      `Input: Hello\n\nTranslations:\n${combined}`,
    );

    expect(translations).toEqual(['Uno', 'Dos', 'Tres']);
    expect(translationModel.calls.length).toBe(3);
    expect(
      translationModel.calls.every(
        (call) => extractUserText(call.input) === 'Hello',
      ),
    ).toBe(true);
    expect(pickerResult.finalOutput).toBe('Pick: Dos');
    expect(extractUserText(pickerModel.lastTurnArgs?.input)).toBe(
      `Input: Hello\n\nTranslations:\n${combined}`,
    );
  });

  it('stops deterministic flow when checker blocks', async () => {
    const outlineModel = new RecordingModel([textMessage('Outline v1')]);
    const checkerModel = new RecordingModel([
      finalOutputMessage(
        JSON.stringify({ good_quality: false, is_scifi: true }),
      ),
    ]);
    const storyModel = new RecordingModel(new Error('story should not run'));

    const outlineAgent = new Agent({ name: 'outline', model: outlineModel });
    const checkerAgent = new Agent({
      name: 'checker',
      model: checkerModel,
      outputType: z.object({
        good_quality: z.boolean(),
        is_scifi: z.boolean(),
      }),
    });
    const storyAgent = new Agent({ name: 'story', model: storyModel });

    let inputs: protocol.UserMessageItem[] = [user('Sci-fi please')];
    const outlineResult = await run(outlineAgent, inputs);
    inputs = outlineResult.history as protocol.UserMessageItem[];

    const checkerResult = await run(checkerAgent, inputs);
    const decision = checkerResult.finalOutput;

    expect(decision?.good_quality).toBe(false);
    expect(decision?.is_scifi).toBe(true);
    if (decision?.good_quality && decision?.is_scifi) {
      await run(storyAgent, outlineResult.finalOutput ?? '');
    }
    expect(storyModel.firstTurnArgs).toBeUndefined();
  });

  it('runs full deterministic path when checker approves', async () => {
    const outlineModel = new RecordingModel([textMessage('Outline ready')]);
    const checkerModel = new RecordingModel([
      finalOutputMessage(
        JSON.stringify({ good_quality: true, is_scifi: true }),
      ),
    ]);
    const storyModel = new RecordingModel([textMessage('Final story')]);

    const outlineAgent = new Agent({ name: 'outline', model: outlineModel });
    const checkerAgent = new Agent({
      name: 'checker',
      model: checkerModel,
      outputType: z.object({
        good_quality: z.boolean(),
        is_scifi: z.boolean(),
      }),
    });
    const storyAgent = new Agent({ name: 'story', model: storyModel });

    let inputs: protocol.UserMessageItem[] = [user('Sci-fi please')];
    const outlineResult = await run(outlineAgent, inputs);
    inputs = outlineResult.history as protocol.UserMessageItem[];

    const checkerResult = await run(checkerAgent, inputs);
    const decision = checkerResult.finalOutput;
    expect(decision?.good_quality).toBe(true);
    expect(decision?.is_scifi).toBe(true);

    const storyResult = await run(storyAgent, outlineResult.finalOutput ?? '');
    expect(storyResult.finalOutput).toBe('Final story');
    expect(extractUserText(storyModel.lastTurnArgs?.input)).toBe(
      'Outline ready',
    );
  });

  it('streams routing result and updates history', async () => {
    const model = new RecordingModel();
    model.setNextOutput([textMessage('Bonjour')]);
    const triageAgent = new Agent({ name: 'triage_agent', model });

    const streamed = await run(triageAgent, 'Salut', { stream: true });

    const deltas: string[] = [];
    for await (const event of streamed) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        deltas.push(event.data.delta);
      }
    }

    expect(deltas.join('')).toBe('Bonjour');
    expect(streamed.finalOutput).toBe('Bonjour');
    expect(streamed.newItems.length).toBe(1);
    const inputList = streamed.history;
    expect(inputList.length).toBe(2);
    const assistantItem = inputList[1] as protocol.AssistantMessageItem;
    expect(assistantItem.role).toBe('assistant');
    const firstContent = Array.isArray(assistantItem.content)
      ? (assistantItem.content[0] as protocol.OutputText)
      : undefined;
    expect(firstContent?.text).toBe('Bonjour');
  });

  it('trips input guardrail and exposes guardrail info', async () => {
    const guardrailModel = new RecordingModel([
      finalOutputMessage(
        JSON.stringify({ reasoning: 'math detected', is_math_homework: true }),
      ),
    ]);
    const guardrailAgent = new Agent({
      name: 'guardrail',
      model: guardrailModel,
      outputType: z.object({
        reasoning: z.string(),
        is_math_homework: z.boolean(),
      }),
    });

    const mainModel = new RecordingModel([textMessage('Should not run')]);
    const mainAgent = new Agent({
      name: 'main',
      model: mainModel,
      inputGuardrails: [
        {
          name: 'Math Guardrail',
          execute: async ({ input, context }) => {
            const result = await run(guardrailAgent, input, { context });
            return {
              tripwireTriggered: result.finalOutput?.is_math_homework ?? false,
              outputInfo: result.finalOutput,
            };
          },
        },
      ],
    });

    await expect(run(mainAgent, 'Solve 2x+5=11')).rejects.toBeInstanceOf(
      InputGuardrailTripwireTriggered,
    );
  });

  it('blocks tool execution when a tool input guardrail trips', async () => {
    let executions = 0;
    const inputGuardrail = defineToolInputGuardrail({
      name: 'tool-blocker',
      run: async ({ toolCall }: { toolCall: protocol.FunctionCallItem }) => {
        const args = toolCall.arguments ?? '';
        if (typeof args === 'string' && args.includes('block')) {
          return {
            behavior: { type: 'throwException' },
            outputInfo: { reason: 'blocked' },
          };
        }
        return { behavior: { type: 'allow' } };
      },
    });

    const guardedTool = tool({
      name: 'echo_tool',
      description: 'Echo',
      parameters: z.object({ text: z.string() }),
      inputGuardrails: [inputGuardrail],
      execute: async ({ text }) => {
        executions += 1;
        return `echo:${text}`;
      },
    });

    const model = new RecordingModel([
      functionToolCall('echo_tool', JSON.stringify({ text: 'block this' })),
    ]);

    const agent = new Agent({
      name: 'tool-guardrail',
      model,
      tools: [guardedTool],
      modelSettings: { toolChoice: 'required' },
    });

    await expect(run(agent, 'guardrail')).rejects.toThrow(
      /tool input guardrail triggered/i,
    );
    expect(executions).toBe(0);
    expect(model.calls.length).toBe(1);
  });

  it('rejects a tool call with guardrail message without executing the tool', async () => {
    let executed = 0;
    const inputGuardrail = defineToolInputGuardrail({
      name: 'redact',
      run: async () => ({
        behavior: { type: 'rejectContent', message: 'blocked:pii' },
      }),
    });

    const guardedTool = tool({
      name: 'pii_check',
      description: 'Should not run',
      parameters: z.object({ text: z.string() }),
      inputGuardrails: [inputGuardrail],
      execute: async () => {
        executed += 1;
        return 'unsafe';
      },
    });

    const model = new RecordingModel([
      functionToolCall('pii_check', JSON.stringify({ text: '123-45-6789' })),
    ]);

    const agent = new Agent({
      name: 'reject-guardrail',
      model,
      tools: [guardedTool],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'contains pii');

    expect(executed).toBe(0);
    expect(result.finalOutput).toBe('blocked:pii');
    expect(result.interruptions ?? []).toHaveLength(0);
  });

  it('resumes an interrupted turn after tool approval without calling the model again', async () => {
    let executed = 0;
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'requires approval',
      parameters: z.object({ input: z.string() }),
      needsApproval: true,
      execute: async ({ input }) => {
        executed += 1;
        return `approved:${input}`;
      },
    });

    const model = new RecordingModel([
      functionToolCall('needs_approval', JSON.stringify({ input: 'hi' })),
    ]);

    const agent = new Agent({
      name: 'approvals',
      model,
      tools: [approvalTool],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const first = await run(agent, 'hello');
    expect(first.interruptions?.length).toBe(1);
    expect(first.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
    expect(model.calls.length).toBe(1);
    warnSpy.mockRestore();

    first.state._context.approveTool(first.interruptions![0], {
      alwaysApprove: true,
    });

    const resumed = await run(agent, first.state);
    expect(resumed.finalOutput).toBe('approved:hi');
    expect(executed).toBe(1);
    expect(model.calls.length).toBe(1);
  });

  it('trips output guardrail on sensitive data', async () => {
    const model = new RecordingModel([
      finalOutputMessage(
        JSON.stringify({
          reasoning: 'User shared phone 650-123-4567',
          response: 'Thanks!',
          user_name: null,
        }),
      ),
    ]);
    const messageOutput = z.object({
      reasoning: z.string(),
      response: z.string(),
      user_name: z.string().nullable(),
    });
    const agent = new Agent({
      name: 'assistant',
      model,
      outputType: messageOutput,
      outputGuardrails: [
        {
          name: 'Phone Guardrail',
          execute: async ({ agentOutput }) => {
            const containsPhone =
              agentOutput.response.includes('650') ||
              agentOutput.reasoning.includes('650');
            return {
              tripwireTriggered: containsPhone,
              outputInfo: { contains_phone: containsPhone },
            };
          },
        },
      ],
    });

    await expect(
      run(agent, 'My phone number is 650-123-4567.'),
    ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
  });

  it('throws when a tool output guardrail trips before returning the tool result', async () => {
    const outputGuardrail = defineToolOutputGuardrail({
      name: 'secret-block',
      run: async ({ output }: { output: unknown }) => {
        if (String(output).includes('secret')) {
          return {
            behavior: { type: 'throwException' },
            outputInfo: { reason: 'secret' },
          };
        }
        return { behavior: { type: 'allow' } };
      },
    });

    const guardedTool = tool({
      name: 'secret_tool',
      description: 'Returns secret',
      parameters: z.object({ code: z.string() }),
      outputGuardrails: [outputGuardrail],
      execute: async ({ code }) => `secret:${code}`,
    });

    const model = new RecordingModel([
      functionToolCall('secret_tool', JSON.stringify({ code: '123' })),
    ]);

    const agent = new Agent({
      name: 'tool-output-guardrail',
      model,
      tools: [guardedTool],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });

    await expect(run(agent, 'get secret')).rejects.toThrow(
      /tool output guardrail triggered/i,
    );
    expect(model.calls.length).toBe(1);
  });

  it('replaces tool output when output guardrail rejects content', async () => {
    let executed = 0;
    const outputGuardrail = defineToolOutputGuardrail({
      name: 'replace-secret',
      run: async ({ output }: { output: unknown }) => {
        return String(output).includes('secret')
          ? { behavior: { type: 'rejectContent', message: '[redacted]' } }
          : { behavior: { type: 'allow' } };
      },
    });

    const guardedTool = tool({
      name: 'secret_tool',
      description: 'Returns secret',
      parameters: z.object({ code: z.string() }),
      outputGuardrails: [outputGuardrail],
      execute: async ({ code }) => {
        executed += 1;
        return `secret:${code}`;
      },
    });

    const model = new RecordingModel([
      functionToolCall('secret_tool', JSON.stringify({ code: '999' })),
    ]);

    const agent = new Agent({
      name: 'tool-output-reject',
      model,
      tools: [guardedTool],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'get secret');
    expect(executed).toBe(1);
    expect(result.finalOutput).toBe('[redacted]');
  });

  it('propagates RunContext mutations set inside tools to later turns', async () => {
    const setStageTool = tool({
      name: 'set_stage',
      description: 'Sets the stage on context',
      parameters: z.object({ stage: z.string() }),
      execute: async ({ stage }, ctx) => {
        if (ctx && typeof ctx.context === 'object') {
          (ctx.context as any).stage = stage;
        }
        return `stage:${stage}`;
      },
    });

    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [functionToolCall('set_stage', JSON.stringify({ stage: 'review' }))],
      [textMessage('done')],
    ]);

    const agent = new Agent({
      name: 'context-mutator',
      model,
      tools: [setStageTool],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'set stage', {
      context: { stage: 'draft' },
    });

    expect(result.finalOutput).toBe('done');
    expect((result.state._context as any).context.stage).toBe('review');
  });

  it('uses sessionInputCallback with server-managed conversations without persisting history', async () => {
    const model = new RecordingModel([textMessage('callback-ok')]);
    const agent = new Agent({ name: 'session-callback', model });

    const history: AgentInputItem[] = [
      user('old message'),
      textMessage('old reply'),
    ];

    const session = {
      getSessionId: async () => 'sess',
      getItems: async () => history,
      addItems: async () => {},
      popItem: async () => undefined,
      clearSession: async () => {},
    } as any;

    const sessionInputCallback = async (
      _historyItems: AgentInputItem[],
      newItems: AgentInputItem[],
    ) => {
      return newItems;
    };

    const result = await run(agent, [user('new message')], {
      session,
      conversationId: 'conv-managed',
      sessionInputCallback,
    });

    expect(result.finalOutput).toBe('callback-ok');

    const lastInput = model.lastTurnArgs?.input;
    expect(Array.isArray(lastInput)).toBe(true);
    if (Array.isArray(lastInput)) {
      expect(lastInput.length).toBe(1);
      expect(extractUserText(lastInput)).toBe('new message');
    }
  });

  it('combines sessionInputCallback and callModelInputFilter and persists filtered items', async () => {
    const model = new RecordingModel([textMessage('filtered ok')]);
    const agent = new Agent({ name: 'session-filter', model });

    const stored: AgentInputItem[] = [user('keep history')];
    const added: AgentInputItem[][] = [];
    const session = {
      getSessionId: async () => 'sess-filter',
      getItems: async () => stored,
      addItems: async (items: AgentInputItem[]) => {
        added.push(items);
        stored.push(...items);
      },
      popItem: async () => undefined,
      clearSession: async () => {},
    } as any;

    const sessionInputCallback = async (
      historyItems: AgentInputItem[],
      newItems: AgentInputItem[],
    ) => {
      return [...historyItems.slice(-1), ...newItems, user('cb-added')];
    };

    const result = await run(agent, [user('SECRET')], {
      session,
      sessionInputCallback,
      // Filter redacts every user message, including items inserted by the callback,
      // and the persisted session state should match what the model saw.
      callModelInputFilter: ({ modelData }) => ({
        ...modelData,
        input: modelData.input.map((item) => {
          if (item.type === 'message' && item.role === 'user') {
            return user('[redacted]');
          }
          return item;
        }),
      }),
    });

    expect(result.finalOutput).toBe('filtered ok');

    const lastInput = model.lastTurnArgs?.input;
    expect(Array.isArray(lastInput)).toBe(true);
    if (Array.isArray(lastInput)) {
      const texts = lastInput
        .filter((item) => item.type === 'message' && item.role === 'user')
        .map((item) => extractUserText([item] as ModelRequest['input']))
        .filter(Boolean);
      // Order: last history item (redacted), filtered new input, callback-inserted item.
      const expectedTexts = ['[redacted]', '[redacted]', '[redacted]'];
      expect(texts).toHaveLength(expectedTexts.length);
      expect(texts).toEqual(expectedTexts);
    }

    expect(added.length).toBe(1);
    const persistedTexts = added[0]
      .filter((item) => item.type === 'message' && item.role === 'user')
      .map((item) => extractUserText([item] as ModelRequest['input']))
      .filter(Boolean);
    // Session only persists the newly provided items (original input + callback addition).
    expect(persistedTexts).toEqual(['[redacted]', '[redacted]']);
    expect(JSON.stringify(added[0])).not.toContain('SECRET');
  });

  it('aggregates usage across multiple model calls and preserves request usage entries', async () => {
    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      {
        output: [functionToolCall('echo', JSON.stringify({ text: 'hi' }))],
        usage: new Usage({
          requests: 1,
          inputTokens: 5,
          outputTokens: 1,
          totalTokens: 6,
          inputTokensDetails: [],
          outputTokensDetails: [],
          requestUsageEntries: [
            {
              inputTokens: 5,
              outputTokens: 1,
              totalTokens: 6,
              endpoint: 'first',
            },
          ],
        }),
      },
      {
        output: [textMessage('ok')],
        usage: new Usage({
          requests: 1,
          inputTokens: 2,
          outputTokens: 2,
          totalTokens: 4,
          inputTokensDetails: [],
          outputTokensDetails: [],
          requestUsageEntries: [
            {
              inputTokens: 2,
              outputTokens: 2,
              totalTokens: 4,
              endpoint: 'second',
            },
          ],
        }),
      },
    ]);

    const echoTool = tool({
      name: 'echo',
      description: 'Echoes text',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => text,
    });

    const agent = new Agent({
      name: 'usage-tracker',
      model,
      tools: [echoTool],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'go');
    expect(result.finalOutput).toBe('ok');
    expect(result.state.usage.requests).toBe(2);
    expect(result.state.usage.totalTokens).toBe(10);
    const endpoints = result.state.usage.requestUsageEntries?.map(
      (entry) => entry.endpoint,
    );
    expect(endpoints).toEqual(['first', 'second']);
  });

  it('executes shell tool calls and forwards shell output to the model', async () => {
    const executed: protocol.ShellAction[] = [];
    const stubShell = {
      run: async (action: protocol.ShellAction) => {
        executed.push(action);
        return {
          output: [
            {
              stdout: 'hi\n',
              stderr: '',
              outcome: { type: 'exit' as const, exitCode: 0 },
            },
          ],
        };
      },
    };
    const shell = shellTool({ name: 'shell', shell: stubShell });

    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [shellCall({ commands: ['echo hi'] })],
      [textMessage('shell ok')],
    ]);

    const agent = new Agent({
      name: 'shell-runner',
      model,
      tools: [shell],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'run shell');
    expect(result.finalOutput).toBe('shell ok');
    expect(executed).toHaveLength(1);
    expect(executed[0].commands).toEqual(['echo hi']);

    const secondInput = model.calls[1]?.input;
    expect(Array.isArray(secondInput)).toBe(true);
    if (Array.isArray(secondInput)) {
      const shellOutputs = secondInput.filter(
        (item): item is protocol.ShellCallResultItem =>
          item.type === 'shell_call_output',
      );
      expect(shellOutputs).toHaveLength(1);
      expect(shellOutputs[0].output[0].stdout).toContain('hi');
    }
  });

  it('runs apply_patch tool calls and exposes editor output to the model', async () => {
    const operations: protocol.ApplyPatchOperation[] = [];
    const editor = {
      createFile: async () => {},
      updateFile: async (operation: protocol.ApplyPatchOperation) => {
        operations.push(operation);
        return { status: 'completed' as const, output: 'updated' };
      },
      deleteFile: async () => {},
    };
    const applyPatch = applyPatchTool({ name: 'apply_patch', editor });

    const callId = 'ap42';
    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [
        applyPatchCall(
          {
            type: 'update_file',
            path: 'README.md',
            diff: 'diff --git a/README.md b/README.md',
          },
          callId,
        ),
      ],
      [textMessage('patched')],
    ]);

    const agent = new Agent({
      name: 'patcher',
      model,
      tools: [applyPatch],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'apply patch');
    expect(result.finalOutput).toBe('patched');
    expect(operations).toHaveLength(1);

    const secondInput = model.calls[1]?.input;
    expect(Array.isArray(secondInput)).toBe(true);
    if (Array.isArray(secondInput)) {
      const patchOutputs = secondInput.filter(
        (item): item is protocol.ApplyPatchCallResultItem =>
          item.type === 'apply_patch_call_output',
      );
      expect(patchOutputs).toHaveLength(1);
      expect(patchOutputs[0].callId).toBe(callId);
      expect(patchOutputs[0].output).toBe('updated');
    }
  });

  it('cancels streaming mid-output when consumer aborts', async () => {
    const model = new RecordingModel([
      textMessage('Chunk1 '),
      textMessage('Chunk2 '),
      textMessage('Chunk3'),
    ]);
    const agent = new Agent({ name: 'talkative', model });

    const streamed = await run(agent, 'Start', { stream: true });
    const reader = (streamed.toStream() as any).getReader();

    let collected = '';
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const event = next.value as RunStreamEvent;
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        collected += event.data.delta;
        if (collected.length >= 'Chunk1 Chunk2 '.length) {
          await reader.cancel('stop');
          break;
        }
      }
    }

    await streamed.completed;
    expect(collected).toContain('Chunk1');
    expect(collected).not.toContain('Chunk3');
    expect(streamed.cancelled).toBe(true);
  });

  it('streams handoff and emits agent update', async () => {
    const delegateModel = new RecordingModel([textMessage('delegate reply')]);
    const delegateAgent = new Agent({ name: 'delegate', model: delegateModel });

    const triageModel = new RecordingModel([
      textMessage('triage summary'),
      handoffToolCall(delegateAgent),
    ]);
    const triageAgent = new Agent({
      name: 'triage',
      model: triageModel,
      handoffs: [delegateAgent],
    });

    const streamed = await run(triageAgent, 'Help me', { stream: true });
    const updates: RunAgentUpdatedStreamEvent[] = [];

    for await (const event of streamed) {
      if (event.type === 'agent_updated_stream_event') {
        updates.push(event);
      }
    }

    expect(streamed.finalOutput).toBe('delegate reply');
    expect(streamed.lastAgent).toBe(delegateAgent);
    expect(updates.some((u) => u.agent === delegateAgent)).toBe(true);
  });

  it('captures nested streaming events when using agents as tools', async () => {
    // Mirrors the docs pattern where an agent is exposed as a streaming tool.
    const billingModel = new RecordingModel([textMessage('Billing: $100')]);
    const billingAgent = new Agent({ name: 'billing', model: billingModel });
    const received: Array<RunStreamEvent> = [];

    const billingTool = billingAgent.asTool({
      toolName: 'billing_agent',
      toolDescription: 'Answer billing questions',
      onStream: (event) => {
        received.push(event.event);
      },
    });

    const mainModel = new RecordingModel();
    mainModel.addMultipleTurnOutputs([
      [
        functionToolCall(
          'billing_agent',
          JSON.stringify({ input: 'Need bill' }),
        ),
      ],
      [textMessage('Final answer')],
    ]);

    const mainAgent = new Agent({
      name: 'support',
      model: mainModel,
      tools: [billingTool],
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(mainAgent, 'How much is my bill?');
    expect(result.finalOutput).toBe('Final answer');
    expect(received.length).toBeGreaterThan(0);
  });

  it('applies handoff input filters before delegating', async () => {
    const delegateModel = new RecordingModel([
      textMessage('Handled filtered input'),
    ]);
    const delegateAgent = new Agent({ name: 'delegate', model: delegateModel });

    const filter = (data: any) => {
      const userOnly = (
        Array.isArray(data.inputHistory) ? data.inputHistory : []
      ).filter(
        (item: AgentInputItem): item is protocol.UserMessageItem =>
          typeof item === 'object' &&
          item !== null &&
          'role' in item &&
          (item as any).role === 'user',
      );
      return {
        ...data,
        inputHistory: userOnly.slice(-1),
      };
    };

    const filteredHandoff = handoff(delegateAgent, {
      inputFilter: filter,
    });
    const triageModel = new RecordingModel([
      functionToolCall(filteredHandoff.toolName, '{}'),
    ]);
    const triageAgent = new Agent({
      name: 'triage',
      model: triageModel,
      handoffs: [filteredHandoff],
    });

    const history: AgentInputItem[] = [
      user('First'),
      textMessage('Old assistant reply'),
      user('Newest'),
    ];

    const result = await run(triageAgent, history);

    expect(result.finalOutput).toBe('Handled filtered input');
    const delegateInput = delegateModel.lastTurnArgs?.input;
    expect(Array.isArray(delegateInput)).toBe(true);
    if (Array.isArray(delegateInput)) {
      const userMessages = delegateInput.filter(
        (item) => item.type === 'message' && item.role === 'user',
      );
      expect(userMessages.length).toBe(1);
      expect(extractUserText(userMessages)).toBe('Newest');
    }
  });

  it('applies runner-level handoffInputFilter when handoff defines none', async () => {
    const delegateModel = new RecordingModel([
      textMessage('Delegate seen last only'),
    ]);
    const delegateAgent = new Agent({ name: 'delegate', model: delegateModel });

    const triageModel = new RecordingModel([
      functionToolCall(handoff(delegateAgent).toolName, '{}'),
    ]);
    const triageAgent = new Agent({
      name: 'triage',
      model: triageModel,
      handoffs: [delegateAgent],
    });

    const runner = new Runner({
      handoffInputFilter: (data) => {
        const tail = Array.isArray(data.inputHistory)
          ? (data.inputHistory as AgentInputItem[]).slice(-1)
          : data.inputHistory;
        return {
          ...data,
          inputHistory: tail,
        };
      },
    });

    const history: AgentInputItem[] = [user('Earlier'), user('Latest message')];
    const result = await runner.run(triageAgent, history);

    expect(result.finalOutput).toBe('Delegate seen last only');
    const delegateInput = delegateModel.lastTurnArgs?.input;
    expect(extractUserText(delegateInput)).toBe('Latest message');
  });

  it('persists session input after AbortError and allows retry without duplication', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      abortError,
      [textMessage('Recovered after abort')],
    ]);

    const agent = new Agent({ name: 'abort-retry', model });
    const session = new MemorySession();

    await expect(run(agent, 'First attempt', { session })).rejects.toThrow(
      'aborted',
    );
    const afterFail = await session.getItems();
    expect(
      afterFail.filter(
        (item): item is protocol.UserMessageItem =>
          item.type === 'message' && item.role === 'user',
      ),
    ).toHaveLength(0);

    const retry = await run(agent, 'Retry now', { session });
    expect(retry.finalOutput).toBe('Recovered after abort');

    const finalItems = await session.getItems();
    const userMessages = finalItems.filter(
      (item): item is protocol.UserMessageItem =>
        item.type === 'message' && item.role === 'user',
    );
    const userTexts = userMessages.map((msg) => {
      if (typeof msg.content === 'string') {
        return msg.content;
      }
      if (Array.isArray(msg.content)) {
        const first = msg.content[0] as protocol.InputText | undefined;
        return first?.type === 'input_text' ? first.text : undefined;
      }
      return undefined;
    });
    expect(userTexts).toEqual(['Retry now']);
    expect(model.calls.length).toBe(2);
  });

  it('throws MaxTurnsExceeded when tool-flow exceeds maxTurns', async () => {
    const testTool = tool({
      name: 'echo_tool',
      description: 'Echo input',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => `echo:${text}`,
    });

    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [functionToolCall('echo_tool', JSON.stringify({ text: 'hi' }))],
      [textMessage('should not reach')],
    ]);

    const agent = new Agent({
      name: 'looper',
      model,
      tools: [testTool],
      toolUseBehavior: 'run_llm_again',
    });

    await expect(
      run(agent, 'keep going', { maxTurns: 1 }),
    ).rejects.toBeInstanceOf(MaxTurnsExceededError);
  });

  it('uses runner-level model override when agent has default placeholder', async () => {
    const runnerModel = new RecordingModel([textMessage('Runner model')]);
    const agent = new Agent({ name: 'no-model' });

    const result = await new Runner({ model: runnerModel }).run(agent, 'hi');

    expect(result.finalOutput).toBe('Runner model');
    expect(runnerModel.lastTurnArgs?.input).toBeDefined();
  });

  it('chains server-managed conversation state and reuses previous response IDs', async () => {
    // Ensures only the delta (tool result) is sent when the server tracks history by conversationId.
    const echoTool = tool({
      name: 'echo_tool',
      description: 'Echo back text',
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => `echo:${text}`,
    });

    const model = new RecordingModel();
    model.addMultipleTurnOutputs([
      [functionToolCall('echo_tool', JSON.stringify({ text: 'hi' }))],
      [textMessage('Echo complete')],
    ]);

    const agent = new Agent({
      name: 'server-conversation',
      model,
      tools: [echoTool],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: 'required' },
    });

    const result = await run(agent, 'hi', { conversationId: 'conv-session' });

    expect(result.finalOutput).toBe('Echo complete');
    expect(model.calls.length).toBe(2);
    expect(model.firstTurnArgs?.conversationId).toBe('conv-session');
    expect(model.lastTurnArgs?.conversationId).toBe('conv-session');
    expect(model.lastTurnArgs?.previousResponseId).toBeUndefined();

    const secondTurnInput = model.lastTurnArgs?.input;
    if (Array.isArray(secondTurnInput)) {
      const userMessages = secondTurnInput.filter(
        (item) => item.type === 'message' && item.role === 'user',
      );
      expect(userMessages.length).toBe(0);
      const toolResults = secondTurnInput.filter(
        (item) => item.type === 'function_call_result',
      );
      expect(toolResults.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('respects forcing tool-use behaviors', async () => {
    const getWeather = tool({
      name: 'get_weather',
      description: 'Get the weather',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}: Sunny`,
    });

    // default: run_llm_again
    const defaultModel = new RecordingModel();
    defaultModel.addMultipleTurnOutputs([
      [
        textMessage('Tool call coming'),
        functionToolCall('get_weather', JSON.stringify({ city: 'Tokyo' })),
      ],
      [textMessage('Done after tool')],
    ]);
    const defaultAgent = new Agent({
      name: 'default',
      model: defaultModel,
      tools: [getWeather],
      toolUseBehavior: 'run_llm_again',
      modelSettings: { toolChoice: undefined },
    });
    const defaultResult = await run(defaultAgent, 'Weather?');
    expect(defaultResult.finalOutput).toBe('Done after tool');
    expect(defaultResult.rawResponses.length).toBe(2);

    // stop_on_first_tool
    const firstModel = new RecordingModel([
      textMessage('Tool call coming'),
      functionToolCall('get_weather', JSON.stringify({ city: 'Paris' })),
    ]);
    const firstAgent = new Agent({
      name: 'first',
      model: firstModel,
      tools: [getWeather],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });
    const firstResult = await run(firstAgent, 'Weather?');
    expect(firstResult.finalOutput).toBe('Paris: Sunny');
    expect(firstResult.rawResponses.length).toBe(1);

    // custom tool behavior
    const customModel = new RecordingModel([
      textMessage('Tool call coming'),
      functionToolCall('get_weather', JSON.stringify({ city: 'Berlin' })),
    ]);
    const customBehavior: ToolUseBehavior = async (
      _context,
      results: FunctionToolResult[],
    ): Promise<ToolsToFinalOutputResult> => {
      const first = results[0];
      if (!first || first.type !== 'function_output') {
        return { isFinalOutput: false, isInterrupted: undefined };
      }
      return {
        isFinalOutput: true,
        finalOutput: `Custom:${String(first.output ?? '')}`,
        isInterrupted: undefined,
      };
    };
    const customAgent = new Agent({
      name: 'custom',
      model: customModel,
      tools: [getWeather],
      toolUseBehavior: customBehavior,
      modelSettings: { toolChoice: 'required' },
    });
    const customResult = await run(customAgent, 'Weather?');
    expect(customResult.finalOutput).toBe('Custom:Berlin: Sunny');
  });

  it('continues with handoff agent on follow-up turn', async () => {
    const delegateModel = new RecordingModel([textMessage('Bonjour')]);
    const delegateAgent = new Agent({ name: 'delegate', model: delegateModel });

    const triageModel = new RecordingModel();
    triageModel.addMultipleTurnOutputs([
      [handoffToolCall(delegateAgent)],
      [textMessage('handoff completed')],
    ]);
    const triageAgent = new Agent({
      name: 'triage',
      model: triageModel,
      handoffs: [delegateAgent],
    });

    const firstResult = await run(triageAgent, 'Help me in French');
    expect(firstResult.finalOutput).toBe('Bonjour');
    expect(firstResult.lastAgent).toBe(delegateAgent);

    delegateModel.setNextOutput([textMessage('Encore?')]);
    const followUpInput = firstResult.history;
    followUpInput.push(user('Encore!'));

    const secondResult = await run(delegateAgent, followUpInput);
    expect(secondResult.finalOutput).toBe('Encore?');
    expect(delegateModel.lastTurnArgs?.input).toEqual(followUpInput);
  });

  it('enables agents-as-tools conditionally', async () => {
    type AppContext = {
      languagePreference: 'spanish_only' | 'french_spanish' | 'european';
    };
    const scenarios: Array<[AppContext['languagePreference'], Set<string>]> = [
      ['spanish_only', new Set(['respond_spanish'])],
      ['french_spanish', new Set(['respond_spanish', 'respond_french'])],
      [
        'european',
        new Set(['respond_spanish', 'respond_french', 'respond_italian']),
      ],
    ];

    const enabledTools = (preference: AppContext['languagePreference']) =>
      new RunContext<AppContext>({ languagePreference: preference });

    for (const [preference, expectedTools] of scenarios) {
      const spanishModel = new RecordingModel([textMessage('ES hola')]);
      const spanishAgent = new Agent<AppContext>({
        name: 'spanish',
        model: spanishModel,
      });

      const frenchModel = new RecordingModel([textMessage('FR bonjour')]);
      const frenchAgent = new Agent<AppContext>({
        name: 'french',
        model: frenchModel,
      });

      const italianModel = new RecordingModel([textMessage('IT ciao')]);
      const italianAgent = new Agent<AppContext>({
        name: 'italian',
        model: italianModel,
      });

      const orchestratorModel = new RecordingModel();
      const toolCalls = Array.from(expectedTools)
        .sort()
        .map((toolName, idx) =>
          functionToolCall(
            toolName,
            JSON.stringify({ input: 'Hi' }),
            `${idx + 1}`,
          ),
        );
      orchestratorModel.addMultipleTurnOutputs([
        toolCalls,
        [textMessage('Done')],
      ]);

      const orchestrator = new Agent<AppContext>({
        name: 'orchestrator',
        model: orchestratorModel,
        tools: [
          spanishAgent.asTool({
            toolName: 'respond_spanish',
            toolDescription: 'Spanish',
            isEnabled: true,
          }),
          frenchAgent.asTool({
            toolName: 'respond_french',
            toolDescription: 'French',
            isEnabled: ({ runContext }) =>
              runContext.context.languagePreference === 'french_spanish' ||
              runContext.context.languagePreference === 'european',
          }),
          italianAgent.asTool({
            toolName: 'respond_italian',
            toolDescription: 'Italian',
            isEnabled: ({ runContext }) =>
              runContext.context.languagePreference === 'european',
          }),
        ],
        modelSettings: { toolChoice: 'required' } as ModelSettings,
      });

      const context = enabledTools(preference);
      const result = await run(orchestrator, 'Hello', { context });
      expect(result.finalOutput).toBe('Done');

      expect(spanishModel.firstTurnArgs !== undefined).toBe(
        expectedTools.has('respond_spanish'),
      );
      expect(frenchModel.firstTurnArgs !== undefined).toBe(
        expectedTools.has('respond_french'),
      );
      expect(italianModel.firstTurnArgs !== undefined).toBe(
        expectedTools.has('respond_italian'),
      );
    }
  });

  it('omits disabled agents-as-tools from the serialized tool list', async () => {
    const model = new RecordingModel([textMessage('Only Spanish')]);
    const orchestrator = new Agent({
      name: 'orchestrator',
      model,
      tools: [
        new Agent({
          name: 'spanish',
          model: new RecordingModel([textMessage('Hola')]),
        }).asTool({
          toolName: 'respond_spanish',
          toolDescription: 'Spanish',
          isEnabled: true,
        }),
        new Agent({
          name: 'italian',
          model: new RecordingModel([textMessage('Ciao')]),
        }).asTool({
          toolName: 'respond_italian',
          toolDescription: 'Italian',
          isEnabled: false,
        }),
      ],
    });

    const result = await run(orchestrator, 'Hello');
    expect(result.finalOutput).toBe('Only Spanish');
    const toolNames = (model.lastTurnArgs?.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toEqual(['respond_spanish']);
  });

  it('sends hosted MCP tool metadata and records hosted tool calls', async () => {
    const model = new RecordingModel([
      hostedToolCall(
        'fetch_codex_documentation',
        '{"query":"language"}',
        'TypeScript',
      ),
      textMessage('Repo uses TypeScript'),
    ]);

    const mcpTool = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      allowedTools: ['fetch_codex_documentation'],
      requireApproval: 'never',
    });

    const agent = new Agent({
      name: 'mcp-agent',
      model,
      tools: [mcpTool],
    });

    const result = await run(agent, 'Which language is this repo written in?');

    expect(result.finalOutput).toBe('Repo uses TypeScript');
    const tools = model.lastTurnArgs?.tools;
    expect(tools?.[0]).toMatchObject({
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData: {
        type: 'mcp',
        server_label: 'gitmcp',
      },
    });
    const hostedItems = result.newItems.filter(
      (item) => item.rawItem.type === 'hosted_tool_call',
    );
    expect(hostedItems.length).toBe(1);
    expect(hostedItems[0].rawItem).toMatchObject({
      name: 'fetch_codex_documentation',
      output: 'TypeScript',
    });
    expect(result.interruptions ?? []).toHaveLength(0);
  });

  it('requires approval for hosted MCP tool calls and surfaces the interruption', async () => {
    const model = new RecordingModel({
      output: [
        {
          type: 'hosted_tool_call',
          id: 'approval-1',
          name: 'mcp_approval_request',
          status: 'completed',
          providerData: {
            type: 'mcp_approval_request',
            server_label: 'gitmcp',
            name: 'search_codex_code',
            id: 'approval-1',
            arguments: '{}',
          },
        } as protocol.HostedToolCallItem,
      ],
      usage: new Usage(),
      responseId: 'resp-approval',
    } as ModelResponse);

    const mcpTool = hostedMcpTool({
      serverLabel: 'gitmcp',
      serverUrl: 'https://gitmcp.io/openai/codex',
      requireApproval: {
        always: { toolNames: ['search_codex_code'] },
      },
    });

    const agent = new Agent({
      name: 'mcp-approval',
      model,
      tools: [mcpTool],
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const result = await run(agent, 'Check the repo language', {
      conversationId: 'conv-mcp',
    });

    expect(result.interruptions?.length).toBe(1);
    expect(result.interruptions?.[0].name).toBe('search_codex_code');
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Accessed finalOutput before agent run is completed.',
    );
    expect(model.lastTurnArgs?.conversationId).toBe('conv-mcp');
    expect(model.lastTurnArgs?.tools?.[0]).toMatchObject({
      name: 'hosted_mcp',
      providerData: { server_label: 'gitmcp' },
    });

    warnSpy.mockRestore();
  });

  it('orchestrator calls multiple translation tools then summarizes', async () => {
    const spanishModel = new RecordingModel([textMessage('ES hola')]);
    const spanishAgent = new Agent({ name: 'spanish', model: spanishModel });

    const frenchModel = new RecordingModel([textMessage('FR bonjour')]);
    const frenchAgent = new Agent({ name: 'french', model: frenchModel });

    const orchestratorModel = new RecordingModel();
    orchestratorModel.addMultipleTurnOutputs([
      [
        functionToolCall(
          'translate_to_spanish',
          JSON.stringify({ input: 'Hi' }),
        ),
      ],
      [
        functionToolCall(
          'translate_to_french',
          JSON.stringify({ input: 'Hi' }),
        ),
      ],
      [textMessage('Summary complete')],
    ]);

    const orchestrator = new Agent({
      name: 'orchestrator',
      model: orchestratorModel,
      tools: [
        spanishAgent.asTool({
          toolName: 'translate_to_spanish',
          toolDescription: 'Spanish',
        }),
        frenchAgent.asTool({
          toolName: 'translate_to_french',
          toolDescription: 'French',
        }),
      ],
    });

    const result = await run(orchestrator, 'Hi');
    expect(result.finalOutput).toBe('Summary complete');
    expect(extractUserText(spanishModel.lastTurnArgs?.input)).toBe('Hi');
    expect(extractUserText(frenchModel.lastTurnArgs?.input)).toBe('Hi');
    expect(result.rawResponses.length).toBe(3);
  });
});
