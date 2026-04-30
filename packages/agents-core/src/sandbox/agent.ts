import { Agent, type AgentOptions, type AgentOutputType } from '../agent';
import type { RunContext } from '../runContext';
import { TextOutput, UnknownContext } from '../types';
import { SANDBOX_AGENT_BRAND } from './brand';
import { type Capability, Capabilities } from './capabilities';
import { cloneManifest, Manifest } from './manifest';
import { normalizeUser, type SandboxUser } from './users';

export type SandboxBaseInstructions<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> =
  | string
  | ((
      runContext: RunContext<TContext>,
      agent: SandboxAgent<TContext, TOutput>,
    ) => Promise<string> | string);

export type SandboxAgentOptions<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> = AgentOptions<TContext, TOutput> & {
  defaultManifest?: Manifest;
  baseInstructions?: SandboxBaseInstructions<TContext, TOutput>;
  capabilities?: Capability[];
  runAs?: string | SandboxUser;
};

export class SandboxAgent<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> extends Agent<TContext, TOutput> {
  readonly [SANDBOX_AGENT_BRAND] = true;
  defaultManifest?: Manifest;
  baseInstructions?: SandboxBaseInstructions<TContext, TOutput>;
  capabilities: Capability[];
  runAs?: string | SandboxUser;
  runtimeManifest: Manifest;

  constructor(config: SandboxAgentOptions<TContext, TOutput>) {
    super(config);
    if (
      config.baseInstructions !== undefined &&
      typeof config.baseInstructions !== 'string' &&
      typeof config.baseInstructions !== 'function'
    ) {
      throw new TypeError(
        'SandboxAgent baseInstructions must be a string or function.',
      );
    }
    this.defaultManifest = config.defaultManifest
      ? cloneManifest(config.defaultManifest)
      : undefined;
    this.baseInstructions = config.baseInstructions;
    this.capabilities = config.capabilities ?? Capabilities.default();
    this.runAs = normalizeRunAs(config.runAs);
    this.runtimeManifest = this.defaultManifest ?? new Manifest();
  }

  override clone(
    config: Partial<SandboxAgentOptions<TContext, TOutput>>,
  ): SandboxAgent<TContext, TOutput> {
    return new SandboxAgent<TContext, TOutput>({
      name: config.name ?? this.name,
      instructions: config.instructions ?? this.instructions,
      prompt: config.prompt ?? this.prompt,
      handoffDescription: config.handoffDescription ?? this.handoffDescription,
      handoffs: config.handoffs ?? this.handoffs,
      model: config.model ?? this.model,
      modelSettings: config.modelSettings ?? this.modelSettings,
      tools: config.tools ?? this.tools,
      mcpServers: config.mcpServers ?? this.mcpServers,
      inputGuardrails: config.inputGuardrails ?? this.inputGuardrails,
      outputGuardrails: config.outputGuardrails ?? this.outputGuardrails,
      outputType: config.outputType ?? this.outputType,
      toolUseBehavior: config.toolUseBehavior ?? this.toolUseBehavior,
      resetToolChoice: config.resetToolChoice ?? this.resetToolChoice,
      defaultManifest: config.defaultManifest ?? this.defaultManifest,
      baseInstructions: config.baseInstructions ?? this.baseInstructions,
      capabilities: config.capabilities ?? this.capabilities,
      runAs: config.runAs ?? this.runAs,
    });
  }
}

function normalizeRunAs(
  runAs: string | SandboxUser | undefined,
): string | SandboxUser | undefined {
  if (runAs === undefined) {
    return undefined;
  }
  if (typeof runAs === 'string') {
    const trimmed = runAs.trim();
    if (!trimmed) {
      throw new TypeError('SandboxAgent runAs must be non-empty.');
    }
    return trimmed;
  }
  return normalizeUser(runAs);
}
