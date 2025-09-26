import { Agent, AgentOutputType } from './agent';
import { RunContext } from './runContext';
import {
  AgentInputItem,
  JsonObjectSchema,
  ResolveParsedToolParameters,
  TextOutput,
  UnknownContext,
} from './types';
import { RunItem } from './items';
import { ModelBehaviorError, UserError } from './errors';
import { ToolInputParameters } from './tool';
import { toFunctionToolName } from './utils/tools';
import { getSchemaAndParserFromInputType } from './utils/tools';
import { addErrorToCurrentSpan } from './tracing/context';
import logger from './logger';

/**
 * Data passed to the handoff function.
 */
export type HandoffInputData = {
  /**
   * The input history before `Runner.run()` was called.
   */
  inputHistory: string | AgentInputItem[];

  /**
   * The items generated before the agent turn where the handoff was invoked.
   */
  preHandoffItems: RunItem[];

  /**
   * The new items generated during the current agent turn, including the item that triggered the
   * handoff and the tool output message representing the response from the handoff output.
   */
  newItems: RunItem[];
  /**
   * The context of the handoff.
   * Note that, since this property was added later on, it's optional to pass from users.
   */
  runContext?: RunContext<any>;
};

export type HandoffInputFilter = (input: HandoffInputData) => HandoffInputData;

/**
 * Generates the message that will be given as tool output to the model that requested the handoff.
 *
 * @param agent The agent to transfer to
 * @returns The message that will be given as tool output to the model that requested the handoff
 */
export function getTransferMessage<TContext, TOutput extends AgentOutputType>(
  agent: Agent<TContext, TOutput>,
) {
  return JSON.stringify({ assistant: agent.name });
}

/**
 * The default name of the tool that represents the handoff.
 *
 * @param agent The agent to transfer to
 * @returns The name of the tool that represents the handoff
 */
function defaultHandoffToolName<TContext, TOutput extends AgentOutputType>(
  agent: Agent<TContext, TOutput>,
) {
  return `transfer_to_${toFunctionToolName(agent.name)}`;
}

/**
 * Generates the description of the tool that represents the handoff.
 *
 * @param agent The agent to transfer to
 * @returns The description of the tool that represents the handoff
 */
function defaultHandoffToolDescription<
  TContext,
  TOutput extends AgentOutputType,
>(agent: Agent<TContext, TOutput>) {
  return `Handoff to the ${agent.name} agent to handle the request. ${
    agent.handoffDescription ?? ''
  }`;
}

/**
 * A handoff is when an agent delegates a task to another agent.
 * For example, in a customer support scenario you might have a "triage agent" that determines which
 * agent should handle the user's request, and sub-agents that specialize in different areas like
 * billing, account management, etc.
 *
 * @template TContext The context of the handoff
 * @template TOutput The output type of the handoff
 */
type HandoffEnabledPredicate<TContext = UnknownContext> = (args: {
  runContext: RunContext<TContext>;
  agent: Agent<any, any>;
}) => boolean | Promise<boolean>;

type HandoffEnabledOption<TContext> =
  | boolean
  | HandoffEnabledPredicate<TContext>;

export type HandoffEnabledFunction<TContext = UnknownContext> = (args: {
  runContext: RunContext<TContext>;
  agent: Agent<any, any>;
}) => Promise<boolean>;

export class Handoff<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> {
  /**
   * The name of the tool that represents the handoff.
   */
  public toolName: string;

  /**
   * The description of the tool that represents the handoff.
   */
  public toolDescription: string;

  /**
   * The JSON schema for the handoff input. Can be empty if the handoff does not take an input
   */
  public inputJsonSchema: JsonObjectSchema<any> = {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  };

  /**
   * Whether the input JSON schema is in strict mode. We **strongly** recommend setting this to
   * true, as it increases the likelihood of correct JSON input.
   */
  public strictJsonSchema: boolean = true;

  /**
   * The function that invokes the handoff. The parameters passed are:
   * 1. The handoff run context
   * 2. The arguments from the LLM, as a JSON string. Empty string if inputJsonSchema is empty.
   *
   * Must return an agent
   */
  public onInvokeHandoff: (
    context: RunContext<TContext>,
    args: string,
  ) => Promise<Agent<TContext, TOutput>> | Agent<TContext, TOutput>;

  /**
   * The name of the agent that is being handed off to.
   */
  public agentName: string;

  /**
   * A function that filters the inputs that are passed to the next agent. By default, the new agent
   * sees the entire conversation history. In some cases, you may want to filter inputs e.g. to
   * remove older inputs, or remove tools from existing inputs.
   *
   * The function will receive the entire conversation hisstory so far, including the input item
   * that triggered the handoff and a tool call output item representing the handoff tool's output.
   *
   * You are free to modify the input history or new items as you see fit. The next agent that runs
   * will receive `handoffInputData.allItems
   */
  public inputFilter?: HandoffInputFilter;

  /**
   * The agent that is being handed off to.
   */
  public agent: Agent<TContext, TOutput>;

  /**
   * Returns a function tool definition that can be used to invoke the handoff.
   */
  getHandoffAsFunctionTool() {
    return {
      type: 'function' as const,
      name: this.toolName,
      description: this.toolDescription,
      parameters: this.inputJsonSchema,
      strict: this.strictJsonSchema,
    };
  }

  public isEnabled: HandoffEnabledFunction<TContext> = async () => true;

  constructor(
    agent: Agent<TContext, TOutput>,
    onInvokeHandoff: (
      context: RunContext<TContext>,
      args: string,
    ) => Promise<Agent<TContext, TOutput>> | Agent<TContext, TOutput>,
  ) {
    this.agentName = agent.name;
    this.onInvokeHandoff = onInvokeHandoff;
    this.toolName = defaultHandoffToolName(agent);
    this.toolDescription = defaultHandoffToolDescription(agent);
    this.agent = agent;
  }
}

/**
 * A function that runs when the handoff is invoked.
 */
export type OnHandoffCallback<TInputType extends ToolInputParameters> = (
  context: RunContext<any>,
  input?: ResolveParsedToolParameters<TInputType>,
) => Promise<void> | void;

/**
 * Configuration for a handoff.
 */
export type HandoffConfig<
  TInputType extends ToolInputParameters,
  TContext = UnknownContext,
> = {
  /**
   * Optional override for the name of the tool that represents the handoff.
   */
  toolNameOverride?: string;

  /**
   * Optional override for the description of the tool that represents the handoff.
   */
  toolDescriptionOverride?: string;

  /**
   * A function that runs when the handoff is invoked
   */
  onHandoff?: OnHandoffCallback<TInputType>;

  /**
   * The type of the input to the handoff. If provided as a Zod schema, the input will be validated
   * against this type. Only relevant if you pass a function that takes an input
   */
  inputType?: TInputType;

  /**
   * A function that filters the inputs that are passed to the next agent.
   */
  inputFilter?: HandoffInputFilter;

  /**
   * Determines whether the handoff should be available to the model for the current run.
   */
  isEnabled?: HandoffEnabledOption<TContext>;
};

/**
 * Creates a handoff from an agent. Handoffs are automatically created when you pass an agent
 * into the `handoffs` option of the `Agent` constructor. Alternatively, you can use this function
 * to create a handoff manually, giving you more control over configuration.
 *
 * @template TContext The context of the handoff
 * @template TOutput The output type of the handoff
 * @template TInputType The input type of the handoff
 */
export function handoff<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
  TInputType extends ToolInputParameters = ToolInputParameters,
>(
  agent: Agent<TContext, TOutput>,
  config: HandoffConfig<TInputType, TContext> = {},
) {
  let parser: ((input: string) => Promise<any>) | undefined = undefined;

  const hasOnHandoff = !!config.onHandoff;
  const hasInputType = !!config.inputType;
  const hasBothOrNeitherHandoffAndInputType = hasOnHandoff === hasInputType;

  if (!hasBothOrNeitherHandoffAndInputType) {
    throw new UserError(
      'You must provide either both `onHandoff` and `inputType` or neither.',
    );
  }

  async function onInvokeHandoff(
    context: RunContext<any>,
    inputJsonString?: string,
  ) {
    if (parser) {
      if (!inputJsonString) {
        addErrorToCurrentSpan({
          message: `Handoff function expected non empty input but got: ${inputJsonString}`,
          data: {
            details: `input is empty`,
          },
        });
        throw new ModelBehaviorError(
          'Handoff function expected non empty input',
        );
      }
      try {
        // verify that it's valid input but we don't care about the result
        const parsed = await parser(inputJsonString);
        if (config.onHandoff) {
          await config.onHandoff(context, parsed);
        }
      } catch (error) {
        addErrorToCurrentSpan({
          message: `Invalid JSON provided`,
          data: {},
        });
        if (!logger.dontLogToolData) {
          logger.error(
            `Invalid JSON when parsing: ${inputJsonString}. Error: ${error}`,
          );
        }
        throw new ModelBehaviorError('Invalid JSON provided');
      }
    } else {
      await config.onHandoff?.(context);
    }

    return agent;
  }

  const handoff = new Handoff(agent, onInvokeHandoff);

  if (typeof config.isEnabled === 'function') {
    const predicate = config.isEnabled as HandoffEnabledPredicate<TContext>;
    handoff.isEnabled = async ({ runContext, agent }) => {
      const result = await predicate({ runContext, agent });
      return Boolean(result);
    };
  } else if (typeof config.isEnabled === 'boolean') {
    handoff.isEnabled = async () => config.isEnabled as boolean;
  }

  if (config.inputType) {
    const result = getSchemaAndParserFromInputType(
      config.inputType,
      handoff.toolName,
    );
    handoff.inputJsonSchema = result.schema;
    handoff.strictJsonSchema = true;
    parser = result.parser;
  }

  if (config.toolNameOverride) {
    handoff.toolName = config.toolNameOverride;
  }

  if (config.toolDescriptionOverride) {
    handoff.toolDescription = config.toolDescriptionOverride;
  }

  if (config.inputFilter) {
    handoff.inputFilter = config.inputFilter;
  }

  return handoff;
}

/**
 * Returns a handoff for the given agent. If the agent is already wrapped into a handoff,
 * it will be returned as is. Otherwise, a new handoff instance will be created.
 *
 * @template TContext The context of the handoff
 * @template TOutput The output type of the handoff
 */
export function getHandoff<TContext, TOutput extends AgentOutputType>(
  agent: Agent<TContext, TOutput> | Handoff<TContext, TOutput>,
) {
  if (agent instanceof Handoff) {
    return agent;
  }

  return handoff(agent);
}
