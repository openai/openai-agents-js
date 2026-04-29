import type { AgentOutputType } from '../../agent';
import { getDefaultModel } from '../../defaultModel';
import { UserError } from '../../errors';
import type { RunContext } from '../../runContext';
import type { Model } from '../../model';
import { selectModel } from '../../runner/modelSettings';
import type { Capability } from '../capabilities';
import type { SandboxAgent } from '../agent';
import { cloneManifest, Manifest } from '../manifest';
import type { SandboxSessionLike, SandboxSessionState } from '../session';
import {
  getDefaultSandboxInstructions,
  renderFilesystemInstructions,
  renderInstructionSection,
  renderRemoteMountPolicyInstructions,
} from './prompts';
import { manifestWithRunAsUser } from './runAsManifest';

export { getDefaultSandboxInstructions } from './prompts';

type PrepareSandboxAgentArgs<TContext, TOutput extends AgentOutputType> = {
  agent: SandboxAgent<TContext, TOutput>;
  session: SandboxSessionLike<SandboxSessionState>;
  capabilities?: Capability[];
  runConfigModel?: SandboxRuntimeModel;
  processManifest?: boolean;
};

export type ResolvedSandboxRuntimeModel = {
  model: string;
  modelInstance: Model;
};

export type SandboxRuntimeModel = string | Model | ResolvedSandboxRuntimeModel;

export function cloneSandboxCapabilities(
  capabilities: Capability[],
): Capability[] {
  return capabilities.map((capability) => capability.clone());
}

export function prepareSandboxAgent<TContext, TOutput extends AgentOutputType>({
  agent,
  session,
  capabilities,
  runConfigModel,
  processManifest = true,
}: PrepareSandboxAgentArgs<TContext, TOutput>): SandboxAgent<
  TContext,
  TOutput
> {
  const { model: resolvedModel, modelInstance: resolvedModelInstance } =
    resolveSandboxModel(agent, runConfigModel);
  // Capabilities are cloned before binding because tools, instructions, and model
  // sampling parameters can depend on the live session for this run.
  const boundCapabilities = cloneSandboxCapabilities(
    capabilities ?? agent.capabilities,
  ).map((capability) =>
    capability
      .bind(session)
      .bindRunAs(agent.runAs)
      .bindModel(resolvedModel, resolvedModelInstance),
  );
  const boundCapabilityTypes = new Set(
    boundCapabilities.map((capability) => capability.type),
  );
  const runtimeManifest = processManifest
    ? boundCapabilities.reduce(
        (manifest, capability) => capability.processManifest(manifest),
        resolveManifest(agent, session),
      )
    : resolveManifest(agent, session);

  for (const capability of boundCapabilities) {
    const missingTypes = [...capability.requiredCapabilityTypes()].filter(
      (requiredType) => !boundCapabilityTypes.has(requiredType),
    );
    if (missingTypes.length > 0) {
      throw new UserError(
        `${capability.type} requires missing capabilities: ${missingTypes.sort().join(', ')}`,
      );
    }
  }

  const providerData = boundCapabilities.reduce<Record<string, unknown>>(
    (samplingParams, capability) =>
      // Provider data often nests model-specific settings; merge recursively so a
      // capability can add its section without replacing user-supplied siblings.
      mergeSandboxProviderData(
        samplingParams,
        capability.samplingParams({
          model: resolvedModel,
          ...(resolvedModelInstance
            ? { modelInstance: resolvedModelInstance }
            : {}),
        }),
      ),
    {},
  );
  const tools = [
    ...agent.tools,
    ...boundCapabilities.flatMap((capability) => capability.tools()),
  ];

  const prepared = agent.clone({
    capabilities: boundCapabilities,
    tools,
    modelSettings: {
      ...agent.modelSettings,
      providerData: mergeSandboxProviderData(
        agent.modelSettings.providerData as Record<string, unknown> | undefined,
        providerData,
      ),
    },
    instructions: async (runContext, preparedAgent) => {
      const capabilityInstructions = await Promise.all(
        boundCapabilities.map((capability) =>
          capability.instructions(runtimeManifest),
        ),
      );
      const segments: string[] = [];
      const baseInstructions = await renderBaseInstructions(
        agent,
        runContext,
        preparedAgent,
      );
      if (baseInstructions) {
        segments.push(baseInstructions);
      }

      const agentInstructions = await renderAgentInstructions(
        agent.instructions,
        runContext,
        preparedAgent,
      );
      if (agentInstructions) {
        segments.push(
          renderInstructionSection('Agent instructions', agentInstructions),
        );
      }

      const capabilityFragments = capabilityInstructions.filter(
        (fragment): fragment is string => Boolean(fragment),
      );
      if (capabilityFragments.length > 0) {
        segments.push(
          renderInstructionSection(
            'Sandbox capability instructions',
            capabilityFragments.join('\n\n'),
          ),
        );
      }

      const remoteMountPolicy =
        renderRemoteMountPolicyInstructions(runtimeManifest);
      if (remoteMountPolicy) {
        segments.push(
          renderInstructionSection(
            'Sandbox remote mount policy',
            remoteMountPolicy,
          ),
        );
      }

      segments.push(renderFilesystemInstructions(runtimeManifest));

      return segments.join('\n\n');
    },
  });

  if (tools.length === 0 && !agent.hasExplicitToolConfig()) {
    // agent.clone() sees an explicit tools array, but an empty post-capability tool set
    // should preserve the original "no explicit tools" semantics for tool choice.
    (
      prepared as unknown as {
        _toolsExplicitlyConfigured: boolean;
      }
    )._toolsExplicitlyConfigured = false;
  }

  prepared.runtimeManifest = runtimeManifest;
  return prepared;
}

function resolveManifest<TContext, TOutput extends AgentOutputType>(
  agent: SandboxAgent<TContext, TOutput>,
  session: SandboxSessionLike<SandboxSessionState>,
): Manifest {
  const manifestCandidate =
    session.state.manifest ?? agent.defaultManifest ?? new Manifest();

  return manifestWithRunAsUser(cloneManifest(manifestCandidate), agent.runAs);
}

function resolveSandboxModel<TContext, TOutput extends AgentOutputType>(
  agent: SandboxAgent<TContext, TOutput>,
  runConfigModel?: SandboxRuntimeModel,
): { model: string; modelInstance?: Model } {
  let runConfigModelForSelection: string | Model | undefined;
  let runConfigModelInstance: Model | undefined;
  if (isResolvedSandboxRuntimeModel(runConfigModel)) {
    runConfigModelForSelection = runConfigModel.model;
    runConfigModelInstance = runConfigModel.modelInstance;
  } else {
    runConfigModelForSelection = runConfigModel;
    runConfigModelInstance =
      runConfigModel && typeof runConfigModel !== 'string'
        ? runConfigModel
        : undefined;
  }
  const selectedModel = selectModel(agent.model, runConfigModelForSelection);
  if (typeof selectedModel === 'string' && selectedModel.trim().length > 0) {
    return {
      model: selectedModel,
      ...(selectedModel === runConfigModelForSelection && runConfigModelInstance
        ? { modelInstance: runConfigModelInstance }
        : {}),
    };
  }
  if (selectedModel && typeof selectedModel !== 'string') {
    return {
      model: getSandboxRuntimeModelName(selectedModel) ?? getDefaultModel(),
      modelInstance: selectedModel,
    };
  }

  return {
    model: getDefaultModel(),
    ...(runConfigModelInstance
      ? { modelInstance: runConfigModelInstance }
      : {}),
  };
}

function isResolvedSandboxRuntimeModel(
  model: SandboxRuntimeModel | undefined,
): model is ResolvedSandboxRuntimeModel {
  return (
    typeof model === 'object' &&
    model !== null &&
    'model' in model &&
    typeof (model as { model?: unknown }).model === 'string' &&
    'modelInstance' in model
  );
}

function getSandboxRuntimeModelName(model: Model): string | undefined {
  const candidate =
    (model as { model?: string; name?: string } | undefined)?.model ??
    (model as { name?: string } | undefined)?.name;
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate
    : undefined;
}

async function renderAgentInstructions<
  TContext,
  TOutput extends AgentOutputType,
>(
  instructions: SandboxAgent<TContext, TOutput>['instructions'],
  runContext: RunContext<TContext>,
  agent: SandboxAgent<TContext, TOutput> | { name: string },
): Promise<string | undefined> {
  if (typeof instructions === 'function') {
    return await instructions(
      runContext,
      agent as SandboxAgent<TContext, TOutput>,
    );
  }

  return instructions;
}

async function renderBaseInstructions<
  TContext,
  TOutput extends AgentOutputType,
>(
  agent: SandboxAgent<TContext, TOutput>,
  runContext: RunContext<TContext>,
  preparedAgent: SandboxAgent<TContext, TOutput> | { name: string },
): Promise<string> {
  const baseInstructions =
    agent.baseInstructions ?? getDefaultSandboxInstructions();
  if (typeof baseInstructions === 'function') {
    return await baseInstructions(
      runContext,
      preparedAgent as SandboxAgent<TContext, TOutput>,
    );
  }

  return baseInstructions;
}

function mergeSandboxProviderData(
  base: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
): Record<string, unknown> {
  if (!base) {
    return mergePlainRecords({}, update);
  }

  return mergePlainRecords(base, update);
}

function mergePlainRecords(
  base: Record<string, unknown>,
  update: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, updateValue] of Object.entries(update)) {
    const baseValue = merged[key];
    if (isPlainRecord(baseValue) && isPlainRecord(updateValue)) {
      merged[key] = mergePlainRecords(baseValue, updateValue);
      continue;
    }

    merged[key] = updateValue;
  }

  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
