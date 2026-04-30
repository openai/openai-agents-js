import type { AgentInputItem } from '../../types';
import { Capability } from './base';
import { supportsResponsesCompactionTransport } from './transport';

export abstract class CompactionPolicy {
  abstract compactThreshold(model?: string): number;
}

export class StaticCompactionPolicy extends CompactionPolicy {
  readonly threshold: number;

  constructor(threshold: number = 240000) {
    super();
    this.threshold = threshold;
  }

  override compactThreshold(): number {
    return this.threshold;
  }
}

export class DynamicCompactionPolicy extends CompactionPolicy {
  readonly thresholdRatio: number;
  readonly fallbackThreshold: number;

  constructor(
    thresholdRatio: number = 0.9,
    fallbackThreshold: number = 240000,
  ) {
    super();
    this.thresholdRatio = thresholdRatio;
    this.fallbackThreshold = fallbackThreshold;
  }

  override compactThreshold(model?: string): number {
    if (!model) {
      return this.fallbackThreshold;
    }

    const modelInfo = CompactionModelInfo.forModel(model);
    if (!modelInfo) {
      return this.fallbackThreshold;
    }

    return Math.floor(modelInfo.contextWindow * this.thresholdRatio);
  }
}

export class CompactionModelInfo {
  readonly contextWindow: number;

  constructor(contextWindow: number) {
    this.contextWindow = contextWindow;
  }

  static forModel(model: string): CompactionModelInfo | undefined {
    for (const candidate of getSandboxCompactionModelCandidates(model)) {
      if (SANDBOX_CONTEXT_WINDOWS_1M.has(candidate)) {
        return new CompactionModelInfo(1047576);
      }
      if (SANDBOX_CONTEXT_WINDOWS_400K.has(candidate)) {
        return new CompactionModelInfo(400000);
      }
      if (SANDBOX_CONTEXT_WINDOWS_200K.has(candidate)) {
        return new CompactionModelInfo(200000);
      }
      if (SANDBOX_CONTEXT_WINDOWS_128K.has(candidate)) {
        return new CompactionModelInfo(128000);
      }
    }

    return undefined;
  }
}

class CompactionCapability extends Capability {
  readonly type = 'compaction';
  readonly policy: CompactionPolicy;

  constructor(policy: CompactionPolicy = new DynamicCompactionPolicy()) {
    super();
    this.policy = policy;
  }

  override samplingParams(
    samplingParams: Record<string, unknown>,
  ): Record<string, unknown> {
    if (
      samplingParams.modelInstance &&
      !supportsResponsesCompactionTransport(samplingParams.modelInstance)
    ) {
      return {};
    }
    const model =
      typeof samplingParams.model === 'string'
        ? samplingParams.model
        : undefined;
    return {
      context_management: [
        {
          type: 'compaction',
          compact_threshold: this.policy.compactThreshold(model),
        },
      ],
    };
  }

  override processContext(context: AgentInputItem[]): AgentInputItem[] {
    let lastCompactionIndex = -1;

    for (let index = 0; index < context.length; index += 1) {
      if ((context[index] as { type?: string }).type === 'compaction') {
        lastCompactionIndex = index;
      }
    }

    if (lastCompactionIndex === -1) {
      return context;
    }

    return context.slice(lastCompactionIndex);
  }
}

export type Compaction = CompactionCapability;

export function compaction(
  args: {
    policy?: CompactionPolicy;
  } = {},
): Compaction {
  return new CompactionCapability(args.policy);
}

function getSandboxCompactionModelCandidates(model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) {
    return [];
  }

  const withoutProviderPrefix = trimmed.includes('/')
    ? trimmed.slice(trimmed.lastIndexOf('/') + 1)
    : trimmed;
  const normalized = withoutProviderPrefix.toLowerCase();
  const withoutPinnedDate = normalized.replace(/-\d{4}-\d{2}-\d{2}$/u, '');

  return [...new Set([normalized, withoutPinnedDate])];
}

const SANDBOX_CONTEXT_WINDOWS_1M = new Set([
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.4-pro',
  'gpt-5.4-pro-2026-03-05',
  'gpt-4.1',
  'gpt-4.1-2025-04-14',
  'gpt-4.1-mini',
  'gpt-4.1-mini-2025-04-14',
  'gpt-4.1-nano',
  'gpt-4.1-nano-2025-04-14',
]);

const SANDBOX_CONTEXT_WINDOWS_400K = new Set([
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.2-codex-cyber',
  'gpt-5.2-pro',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
]);

const SANDBOX_CONTEXT_WINDOWS_200K = new Set([
  'codex-mini-latest',
  'o1',
  'o1-2024-12-17',
  'o1-pro',
  'o3',
  'o3-2025-04-16',
  'o3-mini',
  'o3-pro',
  'o3-deep-research',
  'o4-mini',
  'o4-mini-2025-04-16',
  'o4-mini-deep-research',
]);

const SANDBOX_CONTEXT_WINDOWS_128K = new Set([
  'gpt-4o',
  'gpt-4o-2024-08-06',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18',
  'gpt-5-chat-latest',
  'gpt-5.1-chat-latest',
  'gpt-5.2-chat-latest',
  'gpt-5.3-chat-latest',
]);
