import { UserError } from '../../errors';
import type { Model, ModelSettings } from '../../model';
import { dir } from '../entries';
import { normalizeRelativePath, type Manifest } from '../manifest';
import { withSandboxSpan } from '../runtime/spans';
import { shellQuote } from '../shared/shell';
import type {
  ExecCommandArgs,
  ReadFileArgs,
  SandboxSessionLike,
} from '../session';
import { renderMemoryReadPrompt } from '../memory/prompts';
import {
  joinRelativePaths,
  SandboxMemoryStorage,
  type MemoryStore,
} from '../memory/storage';
import { Capability, requireBoundSession } from './base';

const MEMORY_SUMMARY_FILE = 'memory_summary.md';
const MEMORY_SUMMARY_MAX_BYTES = 1_000_000;
const DEFAULT_PHASE_ONE_MODEL = 'gpt-5.4-mini';
const DEFAULT_PHASE_TWO_MODEL = 'gpt-5.4';
const DEFAULT_MEMORY_MODEL_SETTINGS: ModelSettings = {
  reasoning: { effort: 'medium' },
};
const MEMORY_BEGIN_MARKER = '__OPENAI_AGENTS_MEMORY_SUMMARY_BEGIN__';
const MEMORY_END_MARKER = '__OPENAI_AGENTS_MEMORY_SUMMARY_END__';

export type MemoryReadConfig = {
  enabled?: boolean;
  liveUpdate?: boolean;
};

export type MemoryGenerateConfig = {
  enabled?: boolean;
  maxRawMemoriesForConsolidation?: number;
  phaseOneModel?: string | Model;
  phaseOneModelSettings?: ModelSettings;
  phaseTwoModel?: string | Model;
  phaseTwoModelSettings?: ModelSettings;
  extraPrompt?: string;
  model?: string | Model;
  instructions?: string;
};

export type MemoryLayoutConfig = {
  memoriesDir?: string;
  sessionsDir?: string;
  directory?: string;
  summaryFile?: string;
};

export type MemoryArgs = {
  read?: boolean | MemoryReadConfig | null;
  generate?: boolean | MemoryGenerateConfig | null;
  layout?: MemoryLayoutConfig;
  store?: MemoryStore;
};

class MemoryCapability extends Capability {
  readonly type = 'memory';
  readonly read: MemoryReadConfig | null;
  readonly generate: MemoryGenerateConfig | null;
  readonly layout: {
    memoriesDir: string;
    sessionsDir: string;
    summaryFile: string;
  };
  readonly store?: MemoryStore;

  constructor(args: MemoryArgs = {}) {
    super();
    this.read = normalizeReadConfig(args.read);
    this.generate = normalizeGenerateConfig(args.generate);
    this.layout = normalizeLayoutConfig(args.layout);
    this.store = args.store;

    if (this.read === null && this.generate === null) {
      throw new UserError(
        'Memory requires at least one of `read` or `generate`.',
      );
    }
  }

  override requiredCapabilityTypes(): Set<string> {
    if (this.read === null) {
      return new Set();
    }
    if (this.read.liveUpdate) {
      return new Set(['filesystem', 'shell']);
    }
    return new Set(['shell']);
  }

  override processManifest(manifest: Manifest): Manifest {
    if (this.read?.liveUpdate || this.generate !== null) {
      ensureDirectoryEntry(manifest, this.layout.memoriesDir);
    }
    if (this.generate !== null) {
      ensureDirectoryEntry(manifest, this.layout.sessionsDir);
    }
    return manifest;
  }

  override async instructions(_manifest: Manifest): Promise<string | null> {
    if (this.read === null) {
      return null;
    }

    const session = requireBoundSession(this.type, this._session);
    if (this.store) {
      await new SandboxMemoryStorage({
        session,
        runAs: this._runAs,
        store: this.store,
      }).hydrateFromStore(this.layout.memoriesDir);
    }
    const memorySummary = await this.readMemorySummary(session);
    if (!memorySummary) {
      return null;
    }

    return renderMemoryReadPrompt({
      memoryDir: this.layout.memoriesDir,
      memorySummary,
      liveUpdate: Boolean(this.read.liveUpdate),
    });
  }

  private async readMemorySummary(
    session: SandboxSessionLike,
  ): Promise<string | null> {
    const path = joinRelativePaths(
      this.layout.memoriesDir,
      this.layout.summaryFile,
    );

    if (session.pathExists && !(await session.pathExists(path, this._runAs))) {
      return await this.readStoredText(path);
    }

    if (session.readFile) {
      try {
        const payload = await withSandboxSpan(
          'sandbox.memory.read_summary',
          {
            path,
            run_as: this._runAs,
          },
          async () =>
            await session.readFile!({
              path,
              runAs: this._runAs,
              maxBytes: MEMORY_SUMMARY_MAX_BYTES,
            } satisfies ReadFileArgs),
        );
        return normalizeMemorySummaryPayload(payload);
      } catch (error) {
        if (isMissingFileError(error)) {
          return await this.readStoredText(path);
        }
        throw error;
      }
    }

    const stored = await this.readStoredText(path);
    if (stored !== null) {
      return stored;
    }

    if (session.execCommand) {
      return await readMemorySummaryWithShell({
        session,
        path,
        runAs: this._runAs,
      });
    }

    throw new UserError(
      'Memory sandbox sessions must provide readFile() or execCommand().',
    );
  }

  private async readStoredText(path: string): Promise<string | null> {
    const stored = await this.store?.read(path);
    return stored ? normalizeMemorySummaryPayload(stored) : null;
  }
}

export type Memory = MemoryCapability;

export function memory(args: MemoryArgs = {}): Memory {
  return new MemoryCapability(args);
}

export function isMemoryCapability(
  capability: Capability,
): capability is Memory {
  return capability.type === 'memory' && capability instanceof MemoryCapability;
}

function normalizeReadConfig(
  config: boolean | MemoryReadConfig | null | undefined,
): MemoryReadConfig | null {
  if (config === null || config === false) {
    return null;
  }
  if (config === undefined || config === true) {
    return { enabled: true, liveUpdate: true };
  }
  rejectKnownSnakeCaseConfigKeys(config, ['live_update'], 'memory read config');
  if (config.enabled === false) {
    return null;
  }
  return {
    enabled: true,
    liveUpdate: config.liveUpdate ?? true,
  };
}

function normalizeGenerateConfig(
  config: boolean | MemoryGenerateConfig | null | undefined,
): MemoryGenerateConfig | null {
  if (config === null || config === false) {
    return null;
  }
  if (config === undefined || config === true) {
    return {
      enabled: true,
      maxRawMemoriesForConsolidation: 256,
      phaseOneModel: DEFAULT_PHASE_ONE_MODEL,
      phaseOneModelSettings: DEFAULT_MEMORY_MODEL_SETTINGS,
      phaseTwoModel: DEFAULT_PHASE_TWO_MODEL,
      phaseTwoModelSettings: DEFAULT_MEMORY_MODEL_SETTINGS,
    };
  }
  rejectKnownSnakeCaseConfigKeys(
    config,
    [
      'max_raw_memories_for_consolidation',
      'phase_one_model',
      'phase_one_model_settings',
      'phase_two_model',
      'phase_two_model_settings',
      'extra_prompt',
    ],
    'memory generate config',
  );
  if (config.enabled === false) {
    return null;
  }

  const maxRawMemoriesForConsolidation =
    config.maxRawMemoriesForConsolidation ?? 256;
  if (
    !Number.isInteger(maxRawMemoriesForConsolidation) ||
    maxRawMemoriesForConsolidation <= 0 ||
    maxRawMemoriesForConsolidation > 4096
  ) {
    throw new UserError(
      'MemoryGenerateConfig.maxRawMemoriesForConsolidation must be an integer between 1 and 4096.',
    );
  }

  const sharedModel = normalizeMemoryModel(config.model);
  const phaseOneModel = config.phaseOneModel ?? sharedModel;
  const phaseTwoModel = config.phaseTwoModel ?? sharedModel;
  const extraPrompt = config.extraPrompt ?? config.instructions;
  const phaseOneModelSettings =
    config.phaseOneModelSettings ?? DEFAULT_MEMORY_MODEL_SETTINGS;
  const phaseTwoModelSettings =
    config.phaseTwoModelSettings ?? DEFAULT_MEMORY_MODEL_SETTINGS;

  return {
    enabled: true,
    maxRawMemoriesForConsolidation,
    phaseOneModel: phaseOneModel ?? DEFAULT_PHASE_ONE_MODEL,
    phaseTwoModel: phaseTwoModel ?? DEFAULT_PHASE_TWO_MODEL,
    phaseOneModelSettings,
    phaseTwoModelSettings,
    ...(extraPrompt ? { extraPrompt } : {}),
  };
}

function normalizeMemoryModel(
  model: string | Model | undefined,
): string | Model | undefined {
  if (typeof model !== 'string') {
    return model;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLayoutConfig(config: MemoryLayoutConfig | undefined): {
  memoriesDir: string;
  sessionsDir: string;
  summaryFile: string;
} {
  if (config !== undefined) {
    rejectKnownSnakeCaseConfigKeys(
      config,
      ['memories_dir', 'sessions_dir', 'summary_file'],
      'memory layout config',
    );
  }
  const memoriesDir = normalizeRequiredRelativePath(
    'layout.memoriesDir',
    config?.memoriesDir ?? config?.directory ?? 'memories',
  );
  const sessionsDir = normalizeRequiredRelativePath(
    'layout.sessionsDir',
    config?.sessionsDir ?? 'sessions',
  );
  const summaryFile = normalizeRequiredRelativePath(
    'layout.summaryFile',
    config?.summaryFile ?? MEMORY_SUMMARY_FILE,
  );
  if (summaryFile.includes('/')) {
    throw new UserError('Memory layout.summaryFile must be a file name.');
  }
  return {
    memoriesDir,
    sessionsDir,
    summaryFile,
  };
}

function normalizeRequiredRelativePath(name: string, value: string): string {
  let normalized: string;
  try {
    normalized = normalizeRelativePath(value);
  } catch {
    throw new UserError(
      `${name} must be relative to the sandbox workspace root and must not escape root, got: ${value}`,
    );
  }
  if (!normalized) {
    throw new UserError(`${name} must be non-empty.`);
  }
  return normalized;
}

function ensureDirectoryEntry(manifest: Manifest, path: string): void {
  const normalizedPath = normalizeRelativePath(path);
  if (
    !normalizedPath ||
    manifestHasOverlappingEntry(manifest, normalizedPath)
  ) {
    return;
  }
  manifest.entries[normalizedPath] = dir();
}

function manifestHasOverlappingEntry(
  manifest: Manifest,
  path: string,
): boolean {
  const prefix = `${path}/`;
  for (const entryPath of Object.keys(manifest.entries)) {
    const normalizedEntryPath = normalizeRelativePath(entryPath);
    if (
      normalizedEntryPath === path ||
      normalizedEntryPath.startsWith(prefix) ||
      path.startsWith(`${normalizedEntryPath}/`)
    ) {
      return true;
    }
  }
  return false;
}

async function readMemorySummaryWithShell(args: {
  session: SandboxSessionLike;
  path: string;
  runAs?: string;
}): Promise<string | null> {
  const command = [
    `if [ -f ${shellQuote(args.path)} ]; then`,
    `printf '%s\n' ${shellQuote(MEMORY_BEGIN_MARKER)};`,
    `head -c ${MEMORY_SUMMARY_MAX_BYTES} ${shellQuote(args.path)};`,
    `printf '\n%s\n' ${shellQuote(MEMORY_END_MARKER)};`,
    'fi',
  ].join(' ');
  const output = await withSandboxSpan(
    'sandbox.memory.read_summary',
    {
      path: args.path,
      run_as: args.runAs,
    },
    async () =>
      await args.session.execCommand!({
        cmd: command,
        login: false,
        yieldTimeMs: 10_000,
        maxOutputTokens: 20_000,
        runAs: args.runAs,
      } satisfies ExecCommandArgs),
  );

  const begin = output.indexOf(MEMORY_BEGIN_MARKER);
  const end = output.indexOf(
    MEMORY_END_MARKER,
    begin + MEMORY_BEGIN_MARKER.length,
  );
  if (begin < 0 || end < 0) {
    return null;
  }

  return normalizeMemorySummaryPayload(
    output.slice(begin + MEMORY_BEGIN_MARKER.length, end),
  );
}

function normalizeMemorySummaryPayload(
  payload: string | Uint8Array,
): string | null {
  const text =
    typeof payload === 'string'
      ? payload
      : new TextDecoder('utf-8', { fatal: false }).decode(payload);
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function rejectKnownSnakeCaseConfigKeys(
  value: Record<string, unknown>,
  keys: string[],
  source: string,
): void {
  const found = keys.find((key) => key in value);
  if (!found) {
    return;
  }
  throw new UserError(
    `Use camelCase config keys in ${source}; snake_case key "${found}" is not supported.`,
  );
}
