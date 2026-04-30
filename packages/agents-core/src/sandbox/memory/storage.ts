import { UserError } from '../../errors';
import { dir, file } from '../entries';
import { normalizeRelativePath } from '../manifest';
import { withSandboxSpan } from '../runtime/spans';
import { shellQuote } from '../shared/shell';
import type {
  ExecCommandArgs,
  ListDirectoryArgs,
  MaterializeEntryArgs,
  ReadFileArgs,
  SandboxDirectoryEntry,
  SandboxSessionLike,
  SandboxSessionState,
} from '../session';
import type { Memory } from '../capabilities/memory';

const MEMORY_TEXT_MAX_BYTES = 1_000_000;
const MEMORY_READ_BEGIN_MARKER = '__OPENAI_AGENTS_MEMORY_READ_BEGIN__';
const MEMORY_READ_END_MARKER = '__OPENAI_AGENTS_MEMORY_READ_END__';
const MEMORY_READ_MISSING_MARKER = '__OPENAI_AGENTS_MEMORY_READ_MISSING__';
const MEMORY_READ_STATUS_MARKER = '__OPENAI_AGENTS_MEMORY_READ_STATUS__';

export type PhaseTwoSelectionItem = {
  rolloutId: string;
  updatedAt: string;
  rolloutPath: string;
  rolloutSummaryFile: string;
  terminalState: string;
};

export type PhaseTwoInputSelection = {
  selected: PhaseTwoSelectionItem[];
  retainedRolloutIds: Set<string>;
  removed: PhaseTwoSelectionItem[];
};

export interface MemoryStore {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete?(path: string): Promise<void>;
  list?(prefix: string): Promise<string[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly files = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array | null> {
    const file = this.files.get(normalizeRelativePath(path));
    return file ? new Uint8Array(file) : null;
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    this.files.set(normalizeRelativePath(path), new Uint8Array(data));
  }

  async delete(path: string): Promise<void> {
    this.files.delete(normalizeRelativePath(path));
  }

  async list(prefix: string): Promise<string[]> {
    const normalizedPrefix = normalizeRelativePath(prefix);
    const scanPrefix = normalizedPrefix ? `${normalizedPrefix}/` : '';
    return [...this.files.keys()].filter((path) => path.startsWith(scanPrefix));
  }
}

export class SandboxMemoryStorage {
  private readonly session: SandboxSessionLike<SandboxSessionState>;
  private runAs?: string;
  private readonly store?: MemoryStore;
  private readonly appendQueues = new Map<string, Promise<void>>();

  constructor(args: {
    session: SandboxSessionLike<SandboxSessionState>;
    runAs?: string;
    store?: MemoryStore;
  }) {
    this.session = args.session;
    this.runAs = args.runAs;
    this.store = args.store;
  }

  updateRuntimeContext(args: { runAs?: string }): void {
    this.runAs = args.runAs;
  }

  async ensureLayout(memory: Memory): Promise<void> {
    await this.hydrateFromStore(memory.layout.memoriesDir);
    const memoriesDir = memory.layout.memoriesDir;
    await this.ensureDir(memoriesDir);
    await this.ensureDir(joinRelativePaths(memoriesDir, 'raw_memories'));
    await this.ensureDir(joinRelativePaths(memoriesDir, 'rollout_summaries'));
    await this.ensureDir(joinRelativePaths(memoriesDir, 'skills'));
    await this.ensureDir(memory.layout.sessionsDir);
    await this.ensureFile(joinRelativePaths(memoriesDir, 'MEMORY.md'));
    await this.ensureFile(
      joinRelativePaths(memoriesDir, memory.layout.summaryFile),
    );
  }

  async appendJsonl(path: string, payload: unknown): Promise<void> {
    const normalizedPath = normalizeRelativePath(path);
    const line = JSON.stringify(payload);
    await this.runQueuedAppend(normalizedPath, async () => {
      if (!this.session.readFile && this.session.execCommand) {
        await this.appendJsonlWithShell(normalizedPath, line);
        await this.appendJsonlToStore(normalizedPath, line);
        return;
      }

      const existing = (await this.readFullText(normalizedPath)) ?? '';
      const separator =
        existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      await this.writeText(normalizedPath, `${existing}${separator}${line}\n`);
    });
  }

  async readText(path: string): Promise<string | null> {
    const normalizedPath = normalizeRelativePath(path);
    if (this.session.pathExists) {
      const exists = await this.session.pathExists(normalizedPath, this.runAs);
      if (!exists) {
        const stored = await this.store?.read(normalizedPath);
        return stored ? decodeText(stored) : null;
      }
    }

    if (this.session.readFile) {
      try {
        const payload = await withSandboxSpan(
          'sandbox.memory.read_file',
          {
            path: normalizedPath,
            run_as: this.runAs,
          },
          async () =>
            await this.session.readFile!({
              path: normalizedPath,
              runAs: this.runAs,
              maxBytes: MEMORY_TEXT_MAX_BYTES,
            } satisfies ReadFileArgs),
        );
        return decodeText(payload);
      } catch (error) {
        if (isMissingFileError(error)) {
          const stored = await this.store?.read(normalizedPath);
          return stored ? decodeText(stored) : null;
        }
        throw error;
      }
    }

    const stored = await this.store?.read(normalizedPath);
    if (stored) {
      return decodeText(stored);
    }

    if (this.session.execCommand) {
      return await this.readTextWithShell(normalizedPath, {
        maxBytes: MEMORY_TEXT_MAX_BYTES,
      });
    }

    throw new UserError(
      'Memory generation requires sandbox sessions to provide readFile() or execCommand().',
    );
  }

  private async readFullText(path: string): Promise<string | null> {
    const normalizedPath = normalizeRelativePath(path);
    if (this.session.pathExists) {
      const exists = await this.session.pathExists(normalizedPath, this.runAs);
      if (!exists) {
        const stored = await this.store?.read(normalizedPath);
        return stored ? decodeText(stored) : null;
      }
    }

    if (this.session.readFile) {
      try {
        const payload = await withSandboxSpan(
          'sandbox.memory.read_file',
          {
            path: normalizedPath,
            run_as: this.runAs,
            full_read: true,
          },
          async () =>
            await this.session.readFile!({
              path: normalizedPath,
              runAs: this.runAs,
            } satisfies ReadFileArgs),
        );
        return decodeText(payload);
      } catch (error) {
        if (isMissingFileError(error)) {
          const stored = await this.store?.read(normalizedPath);
          return stored ? decodeText(stored) : null;
        }
        throw error;
      }
    }

    const stored = await this.store?.read(normalizedPath);
    if (stored) {
      return decodeText(stored);
    }

    if (this.session.execCommand) {
      return await this.readTextWithShell(normalizedPath, { maxBytes: null });
    }

    throw new UserError(
      'Memory generation requires sandbox sessions to provide readFile() or execCommand().',
    );
  }

  private async runQueuedAppend(
    path: string,
    append: () => Promise<void>,
  ): Promise<void> {
    const previousAppend = this.appendQueues.get(path) ?? Promise.resolve();
    const currentAppend = previousAppend.catch(() => undefined).then(append);
    this.appendQueues.set(path, currentAppend);
    try {
      await currentAppend;
    } finally {
      if (this.appendQueues.get(path) === currentAppend) {
        this.appendQueues.delete(path);
      }
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    if (!this.session.materializeEntry) {
      throw new UserError(
        'Memory generation requires sandbox sessions to provide materializeEntry().',
      );
    }
    // Memory lives in the sandbox workspace, not only in the side store, so agents
    // can inspect or edit it and workspace snapshots carry it across resumes.
    const normalizedPath = normalizeRelativePath(path);
    const payload = new TextEncoder().encode(content);
    await withSandboxSpan(
      'sandbox.memory.write_file',
      {
        path: normalizedPath,
        run_as: this.runAs,
      },
      async () =>
        await this.session.materializeEntry!({
          path: normalizedPath,
          entry: file({ content }),
          runAs: this.runAs,
        } satisfies MaterializeEntryArgs),
    );
    await this.store?.write(normalizedPath, payload);
  }

  async listDir(path: string): Promise<SandboxDirectoryEntry[]> {
    const normalizedPath = normalizeRelativePath(path);
    if (this.session.listDir) {
      try {
        return mergeDirectoryEntries(
          await this.session.listDir({
            path: normalizedPath,
            runAs: this.runAs,
          } satisfies ListDirectoryArgs),
          await this.listStoreDirectory(normalizedPath),
        );
      } catch {
        return await this.listStoreDirectory(normalizedPath);
      }
    }

    const prefix = normalizedPath ? `${normalizedPath}/` : '';
    const manifestEntries: SandboxDirectoryEntry[] = Object.keys(
      this.session.state.manifest.entries,
    )
      .filter((entryPath) => entryPath.startsWith(prefix))
      .map((entryPath) => entryPath.slice(prefix.length))
      .filter(
        (relativePath) =>
          relativePath.length > 0 && !relativePath.includes('/'),
      )
      .map((name) => ({
        name,
        path: `${prefix}${name}`,
        type:
          this.session.state.manifest.entries[`${prefix}${name}`]?.type ===
          'dir'
            ? 'dir'
            : 'file',
      }));
    return mergeDirectoryEntries(
      manifestEntries,
      await this.listStoreDirectory(normalizedPath),
    );
  }

  async hydrateFromStore(prefix: string): Promise<void> {
    if (!this.store?.list || !this.session.materializeEntry) {
      return;
    }
    const files = await this.store.list(prefix);
    for (const filePath of files.sort()) {
      const normalizedPath = normalizeRelativePath(filePath);
      if (
        this.session.pathExists &&
        (await this.session.pathExists(normalizedPath, this.runAs))
      ) {
        continue;
      }
      const payload = await this.store.read(filePath);
      if (!payload) {
        continue;
      }
      await this.session.materializeEntry({
        path: normalizedPath,
        entry: file({ content: payload }),
        runAs: this.runAs,
      });
    }
  }

  private async listStoreDirectory(
    path: string,
  ): Promise<SandboxDirectoryEntry[]> {
    if (!this.store?.list) {
      return [];
    }
    const normalizedPath = normalizeRelativePath(path);
    const prefix = normalizedPath ? `${normalizedPath}/` : '';
    const entries = new Map<string, SandboxDirectoryEntry>();
    for (const filePath of await this.store.list(normalizedPath)) {
      const relativePath = filePath.startsWith(prefix)
        ? filePath.slice(prefix.length)
        : filePath;
      if (!relativePath) {
        continue;
      }
      const [name, ...rest] = relativePath.split('/');
      if (!name) {
        continue;
      }
      entries.set(name, {
        name,
        path: `${prefix}${name}`,
        type: rest.length > 0 ? 'dir' : 'file',
      });
    }
    return [...entries.values()];
  }

  async buildPhaseTwoInputSelection(args: {
    memoriesDir: string;
    maxRawMemoriesForConsolidation: number;
  }): Promise<PhaseTwoInputSelection> {
    const currentItems = await this.listCurrentSelectionItems(args.memoriesDir);
    const selected = currentItems.slice(0, args.maxRawMemoriesForConsolidation);
    const priorSelected = await this.readPhaseTwoSelection(args.memoriesDir);
    const selectedRolloutIds = new Set(selected.map((item) => item.rolloutId));
    const priorRolloutIds = new Set(
      priorSelected.map((item) => item.rolloutId),
    );
    return {
      selected,
      retainedRolloutIds: new Set(
        [...selectedRolloutIds].filter((rolloutId) =>
          priorRolloutIds.has(rolloutId),
        ),
      ),
      removed: priorSelected.filter(
        (item) => !selectedRolloutIds.has(item.rolloutId),
      ),
    };
  }

  async rebuildRawMemories(args: {
    memoriesDir: string;
    selectedItems: PhaseTwoSelectionItem[];
  }): Promise<boolean> {
    const chunks: string[] = [];
    for (const item of args.selectedItems) {
      const rawMemory = await this.readText(
        joinRelativePaths(
          args.memoriesDir,
          'raw_memories',
          `${item.rolloutId}.md`,
        ),
      );
      if (rawMemory !== null && rawMemory.trim().length > 0) {
        chunks.push(rawMemory.trimEnd());
      }
    }
    if (chunks.length === 0) {
      return false;
    }
    await this.writeText(
      joinRelativePaths(args.memoriesDir, 'raw_memories.md'),
      chunks.join('\n\n'),
    );
    return true;
  }

  async writePhaseTwoSelection(args: {
    memoriesDir: string;
    selectedItems: PhaseTwoSelectionItem[];
  }): Promise<void> {
    await this.writeText(
      joinRelativePaths(args.memoriesDir, 'phase_two_selection.json'),
      `${JSON.stringify(
        {
          version: 1,
          updated_at: utcIsoTimestamp(),
          selected: args.selectedItems.map((item) => ({
            rollout_id: item.rolloutId,
            updated_at: item.updatedAt,
            rollout_path: item.rolloutPath,
            rollout_summary_file: item.rolloutSummaryFile,
            terminal_state: item.terminalState,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }

  private async ensureDir(path: string): Promise<void> {
    if (!this.session.materializeEntry) {
      throw new UserError(
        'Memory generation requires sandbox sessions to provide materializeEntry().',
      );
    }
    const normalizedPath = normalizeRelativePath(path);
    await this.session.materializeEntry({
      path: normalizedPath,
      entry: dir(),
      runAs: this.runAs,
    });
  }

  private async ensureFile(path: string): Promise<void> {
    if ((await this.readText(path)) !== null) {
      return;
    }
    await this.writeText(path, '');
  }

  private async readTextWithShell(
    path: string,
    options: { maxBytes: number | null },
  ): Promise<string | null> {
    const readCommand =
      options.maxBytes === null
        ? `cat ${shellQuote(path)};`
        : `head -c ${options.maxBytes} ${shellQuote(path)};`;
    const command = [
      `if [ -f ${shellQuote(path)} ]; then`,
      `printf '%s\n' ${shellQuote(MEMORY_READ_BEGIN_MARKER)};`,
      readCommand,
      'read_status=$?;',
      `printf '%s%s' ${shellQuote(MEMORY_READ_STATUS_MARKER)} "$read_status";`,
      `printf '%s' ${shellQuote(MEMORY_READ_END_MARKER)};`,
      'else',
      `printf '%s' ${shellQuote(MEMORY_READ_MISSING_MARKER)};`,
      'fi',
    ].join(' ');
    const output = await withSandboxSpan(
      'sandbox.memory.read_file',
      {
        path,
        run_as: this.runAs,
      },
      async () =>
        await this.session.execCommand!({
          cmd: command,
          login: false,
          yieldTimeMs: 10_000,
          maxOutputTokens:
            options.maxBytes === null
              ? undefined
              : Math.ceil((options.maxBytes + 4096) / 4),
          runAs: this.runAs,
        } satisfies ExecCommandArgs),
    );

    const begin = output.indexOf(MEMORY_READ_BEGIN_MARKER);
    if (begin < 0 && output.includes(MEMORY_READ_MISSING_MARKER)) {
      return null;
    }

    const status = output.indexOf(
      MEMORY_READ_STATUS_MARKER,
      begin + MEMORY_READ_BEGIN_MARKER.length,
    );
    const end = output.indexOf(
      MEMORY_READ_END_MARKER,
      status + MEMORY_READ_STATUS_MARKER.length,
    );
    if (begin < 0 || status < 0 || end < 0 || execOutputWasTruncated(output)) {
      throw new UserError(
        `Failed to read memory file "${path}" from shell output.`,
      );
    }

    const readStatus = output
      .slice(status + MEMORY_READ_STATUS_MARKER.length, end)
      .trim();
    if (readStatus !== '0') {
      throw new UserError(
        `Failed to read memory file "${path}" from shell; command exited with code ${readStatus}.`,
      );
    }

    const payload = output.slice(
      begin + MEMORY_READ_BEGIN_MARKER.length,
      status,
    );
    return payload.startsWith('\n') ? payload.slice(1) : payload;
  }

  private async appendJsonlWithShell(
    path: string,
    line: string,
  ): Promise<void> {
    const parent = parentRelativePath(path);
    const quotedPath = shellQuote(path);
    const command = [
      parent ? `mkdir -p -- ${shellQuote(parent)};` : '',
      `if [ -f ${quotedPath} ] && [ -s ${quotedPath} ] && [ "$(tail -c 1 ${quotedPath})" != "" ]; then`,
      `printf '\\n' >> ${quotedPath};`,
      'fi;',
      `printf '%s\\n' ${shellQuote(line)} >> ${quotedPath};`,
    ].join(' ');
    const output = await withSandboxSpan(
      'sandbox.memory.append_jsonl',
      {
        path,
        run_as: this.runAs,
      },
      async () =>
        await this.session.execCommand!({
          cmd: command,
          login: false,
          yieldTimeMs: 10_000,
          maxOutputTokens: 20_000,
          runAs: this.runAs,
        } satisfies ExecCommandArgs),
    );
    if (!execOutputSucceeded(output) || execOutputWasTruncated(output)) {
      throw new UserError(
        `Failed to append memory JSONL file "${path}" from shell output.`,
      );
    }
  }

  private async appendJsonlToStore(path: string, line: string): Promise<void> {
    if (!this.store) {
      return;
    }
    const existing = (await this.store.read(path)) ?? new Uint8Array();
    const existingText = decodeText(existing);
    const separator =
      existingText.length > 0 && !existingText.endsWith('\n') ? '\n' : '';
    await this.store.write(
      path,
      new TextEncoder().encode(`${existingText}${separator}${line}\n`),
    );
  }

  private async readPhaseTwoSelection(
    memoriesDir: string,
  ): Promise<PhaseTwoSelectionItem[]> {
    const rawPayload = await this.readText(
      joinRelativePaths(memoriesDir, 'phase_two_selection.json'),
    );
    if (rawPayload === null) {
      return [];
    }
    try {
      const payload = JSON.parse(rawPayload) as { selected?: unknown };
      if (!Array.isArray(payload.selected)) {
        return [];
      }
      return payload.selected
        .map((entry) => selectionItemFromJson(entry))
        .filter((entry): entry is PhaseTwoSelectionItem => entry !== null);
    } catch {
      return [];
    }
  }

  private async listCurrentSelectionItems(
    memoriesDir: string,
  ): Promise<PhaseTwoSelectionItem[]> {
    const rawMemoriesDir = joinRelativePaths(memoriesDir, 'raw_memories');
    const entries = await this.listDir(rawMemoriesDir);
    const items: Array<{
      sortKey: [number, string];
      rolloutId: string;
      item: PhaseTwoSelectionItem;
    }> = [];
    for (const entry of entries) {
      if (entry.type === 'dir' || !entry.name.endsWith('.md')) {
        continue;
      }
      const rawMemory = await this.readText(
        joinRelativePaths(rawMemoriesDir, entry.name),
      );
      if (rawMemory === null) {
        continue;
      }
      const item = extractSelectionItem(rawMemory);
      if (item !== null) {
        items.push({
          sortKey: updatedAtSortKey(rawMemory),
          rolloutId: item.rolloutId,
          item,
        });
      }
    }
    items.sort((left, right) => {
      const sortComparison =
        right.sortKey[0] - left.sortKey[0] ||
        right.sortKey[1].localeCompare(left.sortKey[1]);
      return sortComparison || right.rolloutId.localeCompare(left.rolloutId);
    });
    return items.map((item) => item.item);
  }
}

export function joinRelativePaths(
  left: string,
  right: string,
  ...rest: string[]
): string {
  return [left, right, ...rest].reduce((prefix, part) => {
    const normalizedPrefix = normalizeRelativePath(prefix);
    const normalizedPart = normalizeRelativePath(part);
    if (!normalizedPrefix) {
      return normalizedPart;
    }
    if (!normalizedPart) {
      return normalizedPrefix;
    }
    return `${normalizedPrefix}/${normalizedPart}`;
  });
}

function selectionItemFromJson(value: unknown): PhaseTwoSelectionItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const rolloutId = stringValue(payload.rollout_id).trim();
  const rolloutSummaryFile = stringValue(payload.rollout_summary_file).trim();
  if (!rolloutId || !rolloutSummaryFile) {
    return null;
  }
  return {
    rolloutId,
    updatedAt: stringValue(payload.updated_at).trim(),
    rolloutPath: stringValue(payload.rollout_path).trim(),
    rolloutSummaryFile,
    terminalState: stringValue(payload.terminal_state).trim(),
  };
}

function extractSelectionItem(rawMemory: string): PhaseTwoSelectionItem | null {
  const rolloutId = extractMetadataValue(rawMemory, 'rollout_id');
  const rolloutSummaryFile = extractMetadataValue(
    rawMemory,
    'rollout_summary_file',
  );
  if (!rolloutId || !rolloutSummaryFile) {
    return null;
  }
  return {
    rolloutId,
    updatedAt: extractMetadataValue(rawMemory, 'updated_at'),
    rolloutPath: extractMetadataValue(rawMemory, 'rollout_path'),
    rolloutSummaryFile,
    terminalState: extractMetadataValue(rawMemory, 'terminal_state'),
  };
}

function extractMetadataValue(rawMemory: string, key: string): string {
  const prefix = `${key}:`;
  for (const line of rawMemory.split('\n')) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }
  return '';
}

function updatedAtSortKey(rawMemory: string): [number, string] {
  const updatedAt = extractMetadataValue(rawMemory, 'updated_at');
  if (!updatedAt || updatedAt === 'unknown') {
    return [0, ''];
  }
  return [1, updatedAt];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decodeText(payload: string | Uint8Array): string {
  if (typeof payload === 'string') {
    return payload;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(payload);
}

function parentRelativePath(path: string): string {
  const normalizedPath = normalizeRelativePath(path);
  const index = normalizedPath.lastIndexOf('/');
  return index < 0 ? '' : normalizedPath.slice(0, index);
}

function execOutputSucceeded(output: string): boolean {
  return /(?:^|\n)Process exited with code 0(?:\n|$)/u.test(output);
}

function execOutputWasTruncated(output: string): boolean {
  const outputMarker = '\nOutput:';
  const outputStart = output.indexOf(outputMarker);
  const metadata = outputStart < 0 ? output : output.slice(0, outputStart + 1);
  return /(?:^|\n)Original token count: \d+(?:\n|$)/u.test(metadata);
}

function mergeDirectoryEntries(
  left: SandboxDirectoryEntry[],
  right: SandboxDirectoryEntry[],
): SandboxDirectoryEntry[] {
  const merged = new Map<string, SandboxDirectoryEntry>();
  for (const entry of [...left, ...right]) {
    const existing = merged.get(entry.name);
    if (existing?.type === 'dir') {
      continue;
    }
    merged.set(entry.name, entry);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function utcIsoTimestamp(): string {
  return new Date().toISOString().replace(/Z$/, '+00:00');
}
