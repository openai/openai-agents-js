import { randomUUID } from '@openai/agents-core/_shims';
import { z } from 'zod';
import type { Agent, AgentOutputType } from '../../agent';
import { UserError } from '../../errors';
import logger from '../../logger';
import type { RunState } from '../../runState';
import type { AgentInputItem } from '../../types';
import { Manifest } from '../manifest';
import { registerSandboxPreStopHook } from '../runtime/sessionLifecycle';
import { withSandboxSpan } from '../runtime/spans';
import { stableJsonStringify } from '../shared/stableJson';
import type { SandboxSessionLike, SandboxSessionState } from '../session';
import type { Memory, MemoryGenerateConfig } from '../capabilities/memory';
import {
  buildMemoryRolloutPayload,
  normalizeRolloutSlug,
  renderPhaseOnePrompt,
  resolveMemoryRolloutId,
  type MemoryRolloutIdentity,
} from './rollouts';
import { joinRelativePaths, SandboxMemoryStorage } from './storage';
import {
  renderMemoryConsolidationPrompt,
  renderRolloutExtractionInstructions,
  renderRolloutExtractionUserPrompt,
} from './prompts';

const RolloutExtractionArtifactsSchema = z.object({
  rollout_summary: z.string(),
  rollout_slug: z.string(),
  raw_memory: z.string(),
});

type RolloutExtractionArtifacts = z.infer<
  typeof RolloutExtractionArtifactsSchema
>;

type MemoryLayoutKey = string;

type MemoryManagerRegistryEntry = {
  memory: Memory;
  manager: SandboxMemoryGenerationManager;
  generationSignature: string;
  layout: {
    memoriesDir: string;
    sessionsDir: string;
    summaryFile: string;
  };
};

export type SandboxMemoryAgentRunner = (
  agent: Agent<any, any>,
  input: string,
  options: {
    sandbox: {
      session: SandboxSessionLike<SandboxSessionState>;
      manifest?: Manifest;
    };
    maxTurns?: number;
  },
) => Promise<{ finalOutput: unknown }>;

const managersBySession = new WeakMap<
  SandboxSessionLike<SandboxSessionState>,
  Map<MemoryLayoutKey, MemoryManagerRegistryEntry>
>();

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

export function getOrCreateSandboxMemoryGenerationManager(args: {
  session: SandboxSessionLike<SandboxSessionState>;
  memory: Memory;
  runAs?: string;
  runAgent: SandboxMemoryAgentRunner;
}): SandboxMemoryGenerationManager {
  if (args.memory.generate === null) {
    throw new UserError(
      'SandboxMemoryGenerationManager requires Memory.generate to be enabled.',
    );
  }

  const layout = normalizedLayout(args.memory);
  const layoutKey = memoryLayoutKey(args.memory);
  let registry = managersBySession.get(args.session);
  const existing = registry?.get(layoutKey);
  if (existing) {
    const nextSignature = memoryGenerationSignature(args.memory.generate);
    if (existing.generationSignature !== nextSignature) {
      throw new UserError(
        'Sandbox session already has a different Memory generation config attached for this memory layout.',
      );
    }
    if (existing.manager.isStopped()) {
      registry!.delete(layoutKey);
      if (registry!.size === 0) {
        managersBySession.delete(args.session);
        registry = undefined;
      }
    } else {
      existing.manager.updateRuntimeContext({
        runAs: args.runAs,
        runAgent: args.runAgent,
      });
      return existing.manager;
    }
  }

  if (registry) {
    for (const entry of registry.values()) {
      if (entry.layout.memoriesDir === layout.memoriesDir) {
        throw new UserError(
          `Sandbox session already has a Memory generation capability for memoriesDir=${layout.memoriesDir}. Use a different memoriesDir for isolated memories, or the same layout to share memory.`,
        );
      }
      if (entry.layout.sessionsDir === layout.sessionsDir) {
        throw new UserError(
          `Sandbox session already has a Memory generation capability for sessionsDir=${layout.sessionsDir}. Use a different sessionsDir for isolated memories, or the same layout to share memory.`,
        );
      }
    }
  }

  const manager = new SandboxMemoryGenerationManager(args);
  registry ??= new Map();
  registry.set(layoutKey, {
    memory: args.memory,
    manager,
    generationSignature: memoryGenerationSignature(args.memory.generate),
    layout,
  });
  managersBySession.set(args.session, registry);
  return manager;
}

export class SandboxMemoryGenerationManager {
  private readonly session: SandboxSessionLike<SandboxSessionState>;
  private readonly memory: Memory;
  private runAs?: string;
  private runAgent: SandboxMemoryAgentRunner;
  private readonly storage: SandboxMemoryStorage;
  private readonly pendingRolloutIds = new Set<string>();
  private flushPromise?: Promise<void>;
  private stopped = false;
  private unregisterPreStopHook?: () => void;

  constructor(args: {
    session: SandboxSessionLike<SandboxSessionState>;
    memory: Memory;
    runAs?: string;
    runAgent: SandboxMemoryAgentRunner;
  }) {
    this.session = args.session;
    this.memory = args.memory;
    this.runAs = args.runAs;
    this.runAgent = args.runAgent;
    this.storage = new SandboxMemoryStorage({
      session: args.session,
      runAs: args.runAs,
      store: args.memory.store,
    });
    this.unregisterPreStopHook = registerSandboxPreStopHook(
      this.session,
      async () => {
        await this.flush();
      },
    );
  }

  isStopped(): boolean {
    return this.stopped;
  }

  updateRuntimeContext(args: {
    runAs?: string;
    runAgent: SandboxMemoryAgentRunner;
  }): void {
    this.runAs = args.runAs;
    this.runAgent = args.runAgent;
    this.storage.updateRuntimeContext({ runAs: args.runAs });
  }

  async enqueueState<TContext>(
    state: RunState<TContext, Agent<TContext, AgentOutputType>>,
    args: {
      exception?: unknown;
      inputOverride?: string | AgentInputItem[];
      rolloutIdentity: Omit<MemoryRolloutIdentity, 'fallbackId'>;
    },
  ): Promise<void> {
    if (this.memory.generate === null || this.stopped) {
      return;
    }

    const rolloutId = resolveMemoryRolloutId({
      ...args.rolloutIdentity,
      fallbackId: randomUUID(),
    });
    const payload = buildMemoryRolloutPayload(state, {
      rolloutId,
      exception: args.exception,
      inputOverride: args.inputOverride,
    });

    await withSandboxSpan(
      'sandbox.memory.enqueue_rollout',
      {
        rollout_id: rolloutId,
      },
      async () => {
        await this.storage.ensureLayout(this.memory);
        await this.storage.appendJsonl(
          joinRelativePaths(
            this.memory.layout.sessionsDir,
            `${rolloutId}.jsonl`,
          ),
          payload,
        );
        this.pendingRolloutIds.add(rolloutId);
      },
    );
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    this.flushPromise = this.flushOnce();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = undefined;
    }
  }

  private async flushOnce(): Promise<void> {
    if (this.memory.generate === null) {
      return;
    }
    if (this.stopped) {
      this.unregister();
      return;
    }
    this.stopped = true;

    try {
      await withSandboxSpan(
        'sandbox.memory.flush',
        {
          rollout_count: this.pendingRolloutIds.size,
        },
        async () => {
          await this.storage.ensureLayout(this.memory);
          let wroteArtifacts = false;
          for (const rolloutId of [...this.pendingRolloutIds].sort()) {
            try {
              const extraction = await this.runPhaseOne(rolloutId);
              if (!validateRolloutArtifacts(extraction)) {
                continue;
              }
              await this.persistPhaseOneArtifacts(rolloutId, extraction);
              wroteArtifacts = true;
            } catch (error) {
              logger.warn(
                `Sandbox memory phase 1 failed for rollout ${rolloutId}: ${error}`,
              );
            }
          }

          if (wroteArtifacts) {
            try {
              await this.runPhaseTwo();
            } catch (error) {
              logger.warn(`Sandbox memory phase 2 failed: ${error}`);
            }
          }
        },
      );
    } finally {
      this.pendingRolloutIds.clear();
      this.unregister();
    }
  }

  private async runPhaseOne(
    rolloutId: string,
  ): Promise<RolloutExtractionArtifacts> {
    const generate = this.memory.generate;
    if (generate === null) {
      throw new UserError('Memory generation is disabled.');
    }

    const transcriptPath = joinRelativePaths(
      this.memory.layout.sessionsDir,
      `${rolloutId}.jsonl`,
    );
    const transcript = await this.storage.readText(transcriptPath);
    if (!transcript) {
      throw new UserError(
        `Memory rollout transcript was not found: ${transcriptPath}`,
      );
    }

    const { SandboxAgent } = await import('../agent');
    const phaseOneAgent = new SandboxAgent({
      name: 'sandbox-memory-phase-one',
      instructions: renderRolloutExtractionInstructions(generate.extraPrompt),
      model: generate.phaseOneModel,
      modelSettings: generate.phaseOneModelSettings,
      outputType: RolloutExtractionArtifactsSchema,
      defaultManifest: this.currentManifest(),
      runAs: this.runAs,
    });
    const result = await this.runAgent(
      phaseOneAgent,
      renderRolloutExtractionUserPrompt({
        terminalMetadataJson: renderPhaseOnePrompt(transcript),
        rolloutContents: transcript,
      }),
      {
        sandbox: {
          session: this.session,
          manifest: this.currentManifest(),
        },
        maxTurns: 500,
      },
    );

    return RolloutExtractionArtifactsSchema.parse(result.finalOutput);
  }

  private async persistPhaseOneArtifacts(
    rolloutId: string,
    extraction: RolloutExtractionArtifacts,
  ): Promise<void> {
    const memoriesDir = this.memory.layout.memoriesDir;
    const transcriptPath = joinRelativePaths(
      this.memory.layout.sessionsDir,
      `${rolloutId}.jsonl`,
    );
    const transcript = await this.storage.readText(transcriptPath);
    const metadata = rolloutMetadataFromTranscript(transcript ?? '');
    const slug = normalizeRolloutSlug(extraction.rollout_slug);
    const rolloutPath = joinRelativePaths(
      this.memory.layout.sessionsDir,
      `${rolloutId}.jsonl`,
    );
    const rolloutSummaryFile = joinRelativePaths(
      'rollout_summaries',
      `${rolloutId}_${slug}.md`,
    );
    await this.storage.writeText(
      joinRelativePaths(memoriesDir, 'raw_memories', `${rolloutId}.md`),
      formatRawMemory({
        updatedAt: metadata.updatedAt,
        rolloutId,
        rolloutPath,
        rolloutSummaryFile,
        terminalState: metadata.terminalState,
        rawMemory: extraction.raw_memory,
      }),
    );
    await this.storage.writeText(
      joinRelativePaths(memoriesDir, rolloutSummaryFile),
      formatRolloutSummary({
        updatedAt: metadata.updatedAt,
        rolloutPath,
        sessionId: String(this.session.state.sessionId ?? ''),
        terminalState: metadata.terminalState,
        rolloutSummary: extraction.rollout_summary,
      }),
    );
  }

  private async runPhaseTwo(): Promise<void> {
    const generate = this.memory.generate;
    if (generate === null) {
      throw new UserError('Memory generation is disabled.');
    }

    const selection = await this.storage.buildPhaseTwoInputSelection({
      memoriesDir: this.memory.layout.memoriesDir,
      maxRawMemoriesForConsolidation:
        generate.maxRawMemoriesForConsolidation ?? 256,
    });
    if (
      !(await this.storage.rebuildRawMemories({
        memoriesDir: this.memory.layout.memoriesDir,
        selectedItems: selection.selected,
      }))
    ) {
      return;
    }

    const { SandboxAgent } = await import('../agent');
    const phaseTwoAgent = new SandboxAgent({
      name: 'sandbox-memory-phase-two',
      model: generate.phaseTwoModel,
      modelSettings: generate.phaseTwoModelSettings,
      defaultManifest: this.currentManifest(),
      runAs: this.runAs,
    });
    await this.runAgent(
      phaseTwoAgent,
      renderMemoryConsolidationPrompt({
        memoryRoot: this.memory.layout.memoriesDir,
        selection,
        extraPrompt: generate.extraPrompt,
      }),
      {
        sandbox: {
          session: this.session,
          manifest: this.currentManifest(),
        },
        maxTurns: 500,
      },
    );
    await this.storage.writePhaseTwoSelection({
      memoriesDir: this.memory.layout.memoriesDir,
      selectedItems: selection.selected,
    });
  }

  private currentManifest(): Manifest {
    return new Manifest(this.session.state.manifest);
  }

  private unregister(): void {
    this.unregisterPreStopHook?.();
    this.unregisterPreStopHook = undefined;

    const registry = managersBySession.get(this.session);
    if (!registry) {
      return;
    }
    const layoutKey = memoryLayoutKey(this.memory);
    const existing = registry.get(layoutKey);
    if (existing?.manager === this) {
      registry.delete(layoutKey);
    }
    if (registry.size === 0) {
      managersBySession.delete(this.session);
    }
  }
}

function validateRolloutArtifacts(
  artifacts: RolloutExtractionArtifacts,
): boolean {
  const hasSlug = artifacts.rollout_slug.trim().length > 0;
  const hasSummary = artifacts.rollout_summary.trim().length > 0;
  const hasRawMemory = artifacts.raw_memory.trim().length > 0;
  if (!hasSlug && !hasSummary && !hasRawMemory) {
    return false;
  }
  if (!hasSlug || !hasSummary || !hasRawMemory) {
    throw new UserError('Phase 1 returned partially-empty memory artifacts.');
  }
  normalizeRolloutSlug(artifacts.rollout_slug);
  return true;
}

function rolloutMetadataFromTranscript(transcript: string): {
  updatedAt: string;
  terminalState: string;
} {
  const payloads = transcript
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
  const lastPayload = payloads[payloads.length - 1];
  if (!lastPayload) {
    return {
      updatedAt: 'unknown',
      terminalState: 'unknown',
    };
  }
  const terminalMetadata = lastPayload.terminal_metadata;
  const terminalState =
    terminalMetadata && typeof terminalMetadata === 'object'
      ? String(
          (terminalMetadata as Record<string, unknown>).terminal_state ??
            'unknown',
        )
      : 'unknown';
  return {
    updatedAt:
      typeof lastPayload.updated_at === 'string'
        ? lastPayload.updated_at
        : 'unknown',
    terminalState,
  };
}

function formatRawMemory(args: {
  updatedAt: string;
  rolloutId: string;
  rolloutPath: string;
  rolloutSummaryFile: string;
  terminalState: string;
  rawMemory: string;
}): string {
  return [
    `rollout_id: ${args.rolloutId}`,
    `updated_at: ${args.updatedAt}`,
    `rollout_path: ${args.rolloutPath}`,
    `rollout_summary_file: ${args.rolloutSummaryFile}`,
    `terminal_state: ${args.terminalState}`,
    '',
    args.rawMemory.trimEnd(),
    '',
  ].join('\n');
}

function formatRolloutSummary(args: {
  updatedAt: string;
  rolloutPath: string;
  sessionId: string;
  terminalState: string;
  rolloutSummary: string;
}): string {
  return [
    `session_id: ${args.sessionId}`,
    `updated_at: ${args.updatedAt}`,
    `rollout_path: ${args.rolloutPath}`,
    `terminal_state: ${args.terminalState}`,
    '',
    args.rolloutSummary.trimEnd(),
    '',
  ].join('\n');
}

function normalizedLayout(
  memory: Memory,
): MemoryManagerRegistryEntry['layout'] {
  return {
    memoriesDir: normalizeLayoutPath(memory.layout.memoriesDir),
    sessionsDir: normalizeLayoutPath(memory.layout.sessionsDir),
    summaryFile: normalizeLayoutPath(memory.layout.summaryFile),
  };
}

function memoryLayoutKey(memory: Memory): string {
  const layout = normalizedLayout(memory);
  return `${layout.memoriesDir}\0${layout.sessionsDir}\0${layout.summaryFile}`;
}

function normalizeLayoutPath(value: string): string {
  return value
    .split('/')
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
}

function memoryGenerationSignature(generate: MemoryGenerateConfig): string {
  return stableJsonStringify(generate, {
    encodeFunction: (value) => `function:${value.name || 'anonymous'}`,
    encodeNonPlainObject: (value) => `object:${objectId(value)}`,
  });
}

function objectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing) {
    return existing;
  }
  const id = nextObjectId++;
  objectIds.set(value, id);
  return id;
}
