import {
  Agent,
  type AgentConfiguration,
  Handoff,
  TextOutput,
  UnknownContext,
} from '@openai/agents-core';
import { RealtimeContextData } from './realtimeSession';

export type RealtimeAgentConfiguration<TContext = UnknownContext> = Partial<
  Omit<
    AgentConfiguration<RealtimeContextData<TContext>, TextOutput>,
    | 'model'
    | 'handoffs'
    | 'modelSettings'
    | 'outputType'
    | 'toolUseBehavior'
    | 'resetToolChoice'
    | 'outputGuardrails'
    | 'inputGuardrails'
    | 'model'
  >
> & {
  /**
   * The name of your realtime agent.
   */
  name: string;

  /**
   * Any other `RealtimeAgent` instances the agent is able to hand off to.
   */
  handoffs?: (
    | RealtimeAgent<TContext>
    | Handoff<RealtimeContextData<TContext>, TextOutput>
  )[];
  /**
   * The voice intended to be used by the agent. If another agent already spoke during the
   * RealtimeSession, changing the voice during a handoff will fail.
   */
  voice?: string;
};

/**
 * A specialized agent instance that is meant to be used within a `RealtimeSession` to build
 * voice agents. Due to the nature of this agent, some configuration options are not supported
 * that are supported by regular `Agent` instances. For example:
 * - `model` choice is not supported as all RealtimeAgents will be handled by the same model within
 *   a `RealtimeSession`
 * - `modelSettings` is not supported as all RealtimeAgents will be handled by the same model within
 *   a `RealtimeSession`
 * - `outputType` is not supported as RealtimeAgents do not support structured outputs
 * - `toolUseBehavior` is not supported as all RealtimeAgents will be handled by the same model within
 *   a `RealtimeSession`
 * - `voice` can be configured on an `Agent` level however it cannot be changed after the first
 *    agent within a `RealtimeSession` spoke
 *
 * @example
 * ```ts
 * const agent = new RealtimeAgent({
 *   name: 'my-agent',
 *   instructions: 'You are a helpful assistant that can answer questions and help with tasks.',
 * })
 *
 * const session = new RealtimeSession(agent);
 * ```
 */
export class RealtimeAgent<TContext = UnknownContext> extends Agent<
  RealtimeContextData<TContext>,
  TextOutput
> {
  /**
   * The voice intended to be used by the agent. If another agent already spoke during the
   * RealtimeSession, changing the voice during a handoff will fail.
   */
  readonly voice?: string;

  constructor(config: RealtimeAgentConfiguration<TContext>) {
    super(
      config as AgentConfiguration<RealtimeContextData<TContext>, TextOutput>,
    );
    this.voice = config.voice;
  }
}
