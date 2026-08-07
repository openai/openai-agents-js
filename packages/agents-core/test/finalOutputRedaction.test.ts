import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  ModelBehaviorError,
  Runner,
  UserError,
  setDefaultModelProvider,
  setTracingDisabled,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ReasoningItem,
  type Session,
  type StreamEvent,
} from '../src';
import { defineOutputGuardrail } from '../src/guardrail';
import logger from '../src/logger';
import { RunResult } from '../src/result';
import { RunContext } from '../src/runContext';
import { runOutputGuardrails } from '../src/runner/guardrails';
import { RunState } from '../src/runState';
import { Usage } from '../src/usage';
import {
  FakeModel,
  FakeModelProvider,
  fakeModelMessage,
  fakeModelRefusal,
} from './stubs';

const MODEL_OUTPUT_SECRET = 'SECRET_STRUCTURED_FINAL_OUTPUT_4207';
const MISSING_OUTPUT_SECRET = 'SECRET_MISSING_STRUCTURED_OUTPUT_4208';
const OVERRIDDEN_PARSER_SECRET = 'SECRET_OVERRIDDEN_FINAL_OUTPUT_4209';
const PERSISTENCE_SECRET = 'SECRET_FINAL_OUTPUT_PERSISTENCE_4210';
const TEXT_OVERRIDE_SECRET = 'SECRET_TEXT_OVERRIDE_4211';
const INVALID_OUTPUT = JSON.stringify({ value: MODEL_OUTPUT_SECRET });
const OVERRIDDEN_PARSER_OUTPUT = JSON.stringify({
  value: OVERRIDDEN_PARSER_SECRET,
});
const REDACTED_OUTPUT_ERROR =
  'Invalid output type: final assistant output did not match the expected schema.';

const outputType = z.object({
  value: z.string().refine((value) => value !== MODEL_OUTPUT_SECRET, {
    message: `Rejected model output ${MODEL_OUTPUT_SECRET}`,
  }),
});

function responseWithInvalidOutput(): ModelResponse {
  return {
    output: [fakeModelMessage(INVALID_OUTPUT)],
    usage: new Usage(),
  };
}

function responseWithMissingOutput(): ModelResponse {
  return {
    output: [
      {
        type: 'reasoning',
        id: 'missing-output-reasoning',
        content: [{ type: 'input_text', text: MISSING_OUTPUT_SECRET }],
      } satisfies ReasoningItem,
    ],
    usage: new Usage(),
  };
}

class StreamingModel implements Model {
  constructor(private readonly response: ModelResponse) {}

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error('Use getStreamedResponse for this model.');
  }

  async *getStreamedResponse(
    _request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    yield {
      type: 'response_done',
      response: {
        id: 'redacted-final-output-response',
        output: this.response.output,
        usage: this.response.usage,
      },
    } as StreamEvent;
  }
}

function createAgent(model?: Model): Agent<unknown, any> {
  return new Agent({
    name: 'Structured output redaction agent',
    outputType,
    ...(model ? { model } : {}),
  }) as Agent<unknown, any>;
}

function expectRedactedError(
  error: unknown,
  secret = MODEL_OUTPUT_SECRET,
): void {
  expect(error).toBeInstanceOf(ModelBehaviorError);
  expect(error).toMatchObject({ message: REDACTED_OUTPUT_ERROR });
  expect(String(error)).not.toContain(secret);
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
}

function overrideFinalOutputParser<TAgent extends Agent<unknown, any>>(
  agent: TAgent,
): TAgent {
  agent.processFinalOutput = (output: string): never => {
    throw new Error(`Overridden parser rejected ${output}`);
  };
  return agent;
}

function renderLoggerCalls(calls: unknown[][]): string {
  return calls.flat().map(String).join('\n');
}

function createRejectingSession(secret: string): Session {
  return {
    async getSessionId() {
      return 'rejecting-final-output-session';
    },
    async getItems() {
      return [];
    },
    async addItems(_items: AgentInputItem[]) {
      throw new Error(`Persistence rejected ${secret}`);
    },
    async popItem() {
      return undefined;
    },
    async clearSession() {},
  };
}

async function captureRunError(stream: boolean): Promise<unknown> {
  const response = responseWithInvalidOutput();
  const agent = createAgent(
    stream ? new StreamingModel(response) : new FakeModel([response]),
  );

  try {
    if (stream) {
      const result = await new Runner().run(agent, 'go', {
        stream: true,
      });
      await result.completed;
    } else {
      await new Runner().run(agent, 'go');
    }
  } catch (error) {
    return error;
  }
  throw new Error('Expected the run to fail.');
}

async function captureOverriddenParserRunError(
  stream: boolean,
): Promise<unknown> {
  const response: ModelResponse = {
    output: [fakeModelMessage(OVERRIDDEN_PARSER_OUTPUT)],
    usage: new Usage(),
  };
  const agent = overrideFinalOutputParser(
    createAgent(
      stream ? new StreamingModel(response) : new FakeModel([response]),
    ),
  );

  return captureOverriddenParserRunErrorWithAgent(agent, stream);
}

async function captureOverriddenParserRunErrorWithAgent(
  agent: Agent<unknown, any>,
  stream: boolean,
): Promise<unknown> {
  try {
    if (stream) {
      const result = await new Runner().run(agent, 'go', { stream: true });
      await result.completed;
    } else {
      await new Runner().run(agent, 'go');
    }
  } catch (error) {
    return error;
  }
  throw new Error('Expected the overridden parser to fail.');
}

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('structured final-output redaction', () => {
  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    '%s mode applies to the result getter',
    (_mode, dontLogModelData) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      const agent = createAgent();

      const capture = (callback: () => unknown) => {
        try {
          callback();
        } catch (error) {
          return error;
        }
        throw new Error('Expected parsing to fail.');
      };

      const state = new RunState(new RunContext(), 'go', agent, 1);
      state._currentStep = {
        type: 'next_step_final_output',
        output: INVALID_OUTPUT,
      };
      const resultError = capture(() => new RunResult(state).finalOutput);

      if (dontLogModelData) {
        expectRedactedError(resultError);
      } else {
        expect(String(resultError)).toContain(MODEL_OUTPUT_SECRET);
      }
    },
  );

  it.each([
    ['max-turn', false],
    ['max-turn', true],
    ['model-refusal', false],
    ['model-refusal', true],
  ] as const)(
    'preserves released structured %s fallback diagnostics (stream=%s)',
    async (kind, stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
      const response: ModelResponse = {
        output: [fakeModelRefusal('Cannot comply.')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: `${kind} structured fallback agent`,
        outputType: z.object({ summary: z.string() }),
        model: stream
          ? new StreamingModel(response)
          : new FakeModel([response]),
      });
      const errorHandlers =
        kind === 'max-turn'
          ? {
              maxTurns: () => ({
                finalOutput: { summary: 123 } as any,
              }),
            }
          : {
              modelRefusal: () => ({
                finalOutput: { summary: 123 } as any,
              }),
            };

      let error: unknown;
      try {
        if (stream) {
          const result = await new Runner().run(agent, 'go', {
            stream: true,
            maxTurns: kind === 'max-turn' ? 0 : undefined,
            errorHandlers,
          });
          await result.completed;
        } else {
          await new Runner().run(agent, 'go', {
            maxTurns: kind === 'max-turn' ? 0 : undefined,
            errorHandlers,
          });
        }
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UserError);
      expect(error).toMatchObject({
        message: expect.stringContaining(
          'Invalid run error handler finalOutput:',
        ),
      });
      expect(String(error)).toContain('summary');
      expect(String(error)).not.toContain(REDACTED_OUTPUT_ERROR);
    },
  );

  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    '%s mode preserves text-agent override errors',
    async (_mode, dontLogModelData) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      const originalError = new Error(TEXT_OVERRIDE_SECRET);
      const agent = new Agent({ name: 'Text override agent' }) as Agent<
        unknown,
        any
      >;
      agent.processFinalOutput = (): never => {
        throw originalError;
      };
      const state = new RunState(new RunContext(), 'go', agent, 1);
      state._currentStep = {
        type: 'next_step_final_output',
        output: TEXT_OVERRIDE_SECRET,
      };
      const guardrail = defineOutputGuardrail<any>({
        name: 'never runs for text override failures',
        execute: vi.fn(),
      });

      expect(() => new RunResult(state).finalOutput).toThrow(originalError);
      await expect(
        runOutputGuardrails(state, [guardrail], TEXT_OVERRIDE_SECRET),
      ).rejects.toBe(originalError);
    },
  );

  it.each([
    [
      'max-turn',
      (agent: Agent<unknown, any>) =>
        new Runner().run(agent, 'go', {
          maxTurns: 0,
          errorHandlers: {
            maxTurns: () => ({ finalOutput: 'safe fallback' }),
          },
        }),
    ],
    [
      'model-refusal',
      (agent: Agent<unknown, any>) =>
        new Runner().run(agent, 'go', {
          errorHandlers: {
            modelRefusal: () => ({ finalOutput: 'safe fallback' }),
          },
        }),
    ],
  ] as const)(
    'preserves released %s fallback validation errors',
    async (kind, runWithHandler) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
      const response: ModelResponse = {
        output: [fakeModelRefusal('Cannot comply.')],
        usage: new Usage(),
      };
      const agent = new Agent({
        name: `${kind} text override agent`,
        model: new FakeModel([response]),
      }) as Agent<unknown, any>;
      agent.processFinalOutput = (): never => {
        throw new Error(TEXT_OVERRIDE_SECRET);
      };

      await expect(runWithHandler(agent)).rejects.toMatchObject({
        name: 'UserError',
        message: `Invalid run error handler finalOutput: ${TEXT_OVERRIDE_SECRET}`,
      });
    },
  );

  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    '%s mode applies before output guardrails run',
    async (_mode, dontLogModelData) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      const execute = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const agent = createAgent();
      const state = new RunState(new RunContext(), 'go', agent, 1);
      const guardrail = defineOutputGuardrail<any>({
        name: 'never runs',
        execute,
      });

      let error: unknown;
      try {
        await runOutputGuardrails(state, [guardrail], INVALID_OUTPUT);
      } catch (caught) {
        error = caught;
      }

      expect(execute).not.toHaveBeenCalled();
      if (dontLogModelData) {
        expectRedactedError(error);
      } else {
        expect(String(error)).toContain(MODEL_OUTPUT_SECRET);
      }
    },
  );

  it.each([false, true])(
    'does not inspect hostile fallback validation failures (stream=%s)',
    async (stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
      const inspected = vi.fn();
      const hostileError = new Proxy(
        {},
        {
          get() {
            inspected();
            throw new Error('Hostile error property was inspected.');
          },
          getPrototypeOf() {
            inspected();
            throw new Error('Hostile error prototype was inspected.');
          },
        },
      );
      const response = responseWithInvalidOutput();
      const agent = createAgent(
        stream ? new StreamingModel(response) : new FakeModel([response]),
      );
      agent.processFinalOutput = (): never => {
        throw hostileError;
      };

      let error: unknown;
      try {
        const options = {
          errorHandlers: {
            invalidFinalOutput: () => ({
              finalOutput: { value: 'safe fallback' },
            }),
          },
        };
        if (stream) {
          const result = await new Runner().run(agent, 'go', {
            ...options,
            stream: true,
          });
          await result.completed;
        } else {
          await new Runner().run(agent, 'go', options);
        }
      } catch (caught) {
        error = caught;
      }

      expect(inspected).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(UserError);
      expect(error).toMatchObject({ message: 'Error details are redacted.' });
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it.each([
    ['promotes diagnostic mode to redacted', false, true],
    ['keeps initial redaction after diagnostic opt-in', true, false],
  ] as const)(
    '%s during invalid-output recovery',
    async (_mode, initialRedaction, callbackRedaction) => {
      let dontLogModelData = initialRedaction;
      vi.spyOn(logger, 'dontLogModelData', 'get').mockImplementation(
        () => dontLogModelData,
      );
      const response = responseWithInvalidOutput();
      const agent = createAgent(new FakeModel([response]));

      let error: unknown;
      try {
        await new Runner().run(agent, 'go', {
          errorHandlers: {
            invalidFinalOutput: ({ runData }) => {
              dontLogModelData = callbackRedaction;
              throw new Error(JSON.stringify(runData.rawResponses));
            },
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UserError);
      expect(error).toMatchObject({ message: 'Error details are redacted.' });
      expect(String(error)).not.toContain(MODEL_OUTPUT_SECRET);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it.each([false, true])(
    'does not attach persistence details to redacted guardrail parser failures (stream=%s)',
    async (stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const response: ModelResponse = {
        output: [
          fakeModelMessage(JSON.stringify({ value: OVERRIDDEN_PARSER_SECRET })),
        ],
        usage: new Usage(),
      };
      const agent = createAgent(
        stream ? new StreamingModel(response) : new FakeModel([response]),
      );
      let parserCalls = 0;
      agent.processFinalOutput = (output: string) => {
        parserCalls += 1;
        if (parserCalls === 1) {
          return JSON.parse(output);
        }
        throw new Error(`Guardrail parser rejected ${output}`);
      };
      const guardrail = {
        name: 'never runs after parser failure',
        execute: vi.fn(async () => ({
          tripwireTriggered: false,
          outputInfo: {},
        })),
      };

      let error: unknown;
      try {
        if (stream) {
          const result = await new Runner({
            outputGuardrails: [guardrail],
          }).run(agent, 'go', {
            stream: true,
            session: createRejectingSession(PERSISTENCE_SECRET),
          });
          await result.completed;
        } else {
          await new Runner({ outputGuardrails: [guardrail] }).run(agent, 'go', {
            session: createRejectingSession(PERSISTENCE_SECRET),
          });
        }
      } catch (caught) {
        error = caught;
      }

      expect(parserCalls).toBe(2);
      expectRedactedError(error, OVERRIDDEN_PARSER_SECRET);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      const renderedLoggerCalls = renderLoggerCalls(debugSpy.mock.calls);
      expect(renderedLoggerCalls).not.toContain(OVERRIDDEN_PARSER_SECRET);
      expect(renderedLoggerCalls).not.toContain(PERSISTENCE_SECRET);
    },
  );

  it.each([false, true])(
    'redacts invalid output at the real run boundary (stream=%s)',
    async (stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const error = await captureRunError(stream);

      expectRedactedError(error);
      expect(renderLoggerCalls(debugSpy.mock.calls)).not.toContain(
        MODEL_OUTPUT_SECRET,
      );
    },
  );

  it('preserves run diagnostics after explicit opt-in', async () => {
    vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(false);
    vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

    const error = await captureRunError(true);

    expect(String(error)).toContain(MODEL_OUTPUT_SECRET);
    expect(renderLoggerCalls(debugSpy.mock.calls)).toContain(
      MODEL_OUTPUT_SECRET,
    );
  });

  it.each([
    ['redacted', true, false],
    ['redacted streamed', true, true],
    ['diagnostic', false, false],
    ['diagnostic streamed', false, true],
  ] as const)(
    '%s mode applies to overridden parsers at the real run boundary',
    async (_mode, dontLogModelData, stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const error = await captureOverriddenParserRunError(stream);
      const renderedLoggerCalls = renderLoggerCalls(debugSpy.mock.calls);

      if (dontLogModelData) {
        expectRedactedError(error, OVERRIDDEN_PARSER_SECRET);
        expect(renderedLoggerCalls).not.toContain(OVERRIDDEN_PARSER_SECRET);
      } else {
        expect(String(error)).toContain(OVERRIDDEN_PARSER_SECRET);
      }
    },
  );

  it.each([false, true])(
    'keeps entry redaction when an overridden parser enables diagnostics (stream=%s)',
    async (stream) => {
      let dontLogModelData = true;
      vi.spyOn(logger, 'dontLogModelData', 'get').mockImplementation(
        () => dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const response: ModelResponse = {
        output: [fakeModelMessage(OVERRIDDEN_PARSER_OUTPUT)],
        usage: new Usage(),
      };
      const agent = createAgent(
        stream ? new StreamingModel(response) : new FakeModel([response]),
      );
      agent.processFinalOutput = (output: string): never => {
        dontLogModelData = false;
        throw new Error(`Overridden parser rejected ${output}`);
      };

      const error = await captureOverriddenParserRunErrorWithAgent(
        agent,
        stream,
      );

      expectRedactedError(error, OVERRIDDEN_PARSER_SECRET);
      expect(renderLoggerCalls(debugSpy.mock.calls)).not.toContain(
        OVERRIDDEN_PARSER_SECRET,
      );
    },
  );

  it.each([false, true])(
    'inherits parser-entry redaction in invalid-output recovery (stream=%s)',
    async (stream) => {
      let dontLogModelData = true;
      vi.spyOn(logger, 'dontLogModelData', 'get').mockImplementation(
        () => dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const response: ModelResponse = {
        output: [fakeModelMessage(OVERRIDDEN_PARSER_OUTPUT)],
        usage: new Usage(),
      };
      const agent = createAgent(
        stream ? new StreamingModel(response) : new FakeModel([response]),
      );
      agent.processFinalOutput = (output: string): never => {
        dontLogModelData = false;
        throw new Error(`Overridden parser rejected ${output}`);
      };

      let error: unknown;
      try {
        const options = {
          errorHandlers: {
            invalidFinalOutput: ({
              runData,
            }: {
              runData: { rawResponses: ModelResponse[] };
            }) => {
              throw new Error(JSON.stringify(runData.rawResponses));
            },
          },
        };
        if (stream) {
          const result = await new Runner().run(agent, 'go', {
            ...options,
            stream: true,
          });
          await result.completed;
        } else {
          await new Runner().run(agent, 'go', options);
        }
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(UserError);
      expect(error).toMatchObject({ message: 'Error details are redacted.' });
      expect(String(error)).not.toContain(OVERRIDDEN_PARSER_SECRET);
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(renderLoggerCalls(debugSpy.mock.calls)).not.toContain(
        OVERRIDDEN_PARSER_SECRET,
      );
    },
  );

  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    '%s mode applies to result and guardrail calls into overridden parsers',
    async (_mode, dontLogModelData) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      const agent = overrideFinalOutputParser(createAgent());
      const state = new RunState(new RunContext(), 'go', agent, 1);
      state._currentStep = {
        type: 'next_step_final_output',
        output: OVERRIDDEN_PARSER_OUTPUT,
      };
      const execute = vi.fn(async () => ({
        tripwireTriggered: false,
        outputInfo: {},
      }));
      const guardrail = defineOutputGuardrail<any>({
        name: 'never runs for overridden parser failures',
        execute,
      });

      const capture = async (callback: () => unknown | Promise<unknown>) => {
        try {
          await callback();
        } catch (error) {
          return error;
        }
        throw new Error('Expected the overridden parser to fail.');
      };
      const resultError = await capture(() => new RunResult(state).finalOutput);
      const guardrailError = await capture(() =>
        runOutputGuardrails(state, [guardrail], OVERRIDDEN_PARSER_OUTPUT),
      );

      expect(execute).not.toHaveBeenCalled();
      if (dontLogModelData) {
        expectRedactedError(resultError, OVERRIDDEN_PARSER_SECRET);
        expectRedactedError(guardrailError, OVERRIDDEN_PARSER_SECRET);
      } else {
        expect(String(resultError)).toContain(OVERRIDDEN_PARSER_SECRET);
        expect(String(guardrailError)).toContain(OVERRIDDEN_PARSER_SECRET);
      }
    },
  );

  it('gives invalid-output handlers a redacted error while preserving recovery data', async () => {
    vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(true);
    const retainedErrors: ModelBehaviorError[] = [];
    const response = responseWithInvalidOutput();
    const agent = createAgent(new FakeModel([response]));

    const result = await new Runner().run(agent, 'go', {
      errorHandlers: {
        invalidFinalOutput: ({ error, runData }) => {
          retainedErrors.push(error as ModelBehaviorError);
          expect(JSON.stringify(runData.rawResponses)).toContain(
            MODEL_OUTPUT_SECRET,
          );
          return { finalOutput: { value: 'safe fallback' } };
        },
      },
    });

    expect(result.finalOutput).toEqual({ value: 'safe fallback' });
    expect(retainedErrors).toHaveLength(1);
    expectRedactedError(retainedErrors[0]);
  });

  it.each([
    ['redacted', true],
    ['diagnostic', false],
  ] as const)(
    '%s mode applies when an invalid-output handler exposes recovery data',
    async (_mode, dontLogModelData) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      const response = responseWithInvalidOutput();
      const agent = createAgent(new FakeModel([response]));

      let error: unknown;
      try {
        await new Runner().run(agent, 'go', {
          errorHandlers: {
            invalidFinalOutput: ({ runData }) => {
              throw new Error(JSON.stringify(runData.rawResponses));
            },
          },
        });
      } catch (caught) {
        error = caught;
      }

      if (dontLogModelData) {
        expect(error).toBeInstanceOf(UserError);
        expect(error).toMatchObject({ message: 'Error details are redacted.' });
        expect(String(error)).not.toContain(MODEL_OUTPUT_SECRET);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      } else {
        expect(String(error)).toContain(MODEL_OUTPUT_SECRET);
      }
    },
  );

  it.each([
    ['redacted', true, false],
    ['redacted streamed', true, true],
    ['diagnostic', false, false],
    ['diagnostic streamed', false, true],
  ] as const)(
    '%s mode applies when a missing-output handler exposes raw reasoning data',
    async (_mode, dontLogModelData, stream) => {
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const response = responseWithMissingOutput();
      const agent = createAgent(
        stream ? new StreamingModel(response) : new FakeModel([response]),
      );

      let error: unknown;
      try {
        const options = {
          errorHandlers: {
            invalidFinalOutput: ({
              runData,
            }: {
              runData: { rawResponses: ModelResponse[] };
            }) => {
              throw new Error(JSON.stringify(runData.rawResponses));
            },
          },
        };
        if (stream) {
          const result = await new Runner().run(agent, 'go', {
            ...options,
            stream: true,
          });
          await result.completed;
        } else {
          await new Runner().run(agent, 'go', options);
        }
      } catch (caught) {
        error = caught;
      }

      const renderedLoggerCalls = renderLoggerCalls(debugSpy.mock.calls);
      if (dontLogModelData) {
        expect(error).toBeInstanceOf(UserError);
        expect(error).toMatchObject({ message: 'Error details are redacted.' });
        expect(String(error)).not.toContain(MISSING_OUTPUT_SECRET);
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
        expect(renderedLoggerCalls).not.toContain(MISSING_OUTPUT_SECRET);
      } else {
        expect(String(error)).toContain(MISSING_OUTPUT_SECRET);
      }
    },
  );
});
