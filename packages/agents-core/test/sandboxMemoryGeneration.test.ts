import { createHash } from 'node:crypto';
import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ApplyPatchOperation,
  ApplyPatchResult,
  Editor,
} from '../src/editor';
import { Agent } from '../src/agent';
import { handoff } from '../src/handoff';
import { run, Runner } from '../src/run';
import { setDefaultModelProvider } from '../src';
import { tool } from '../src/tool';
import type { Model, ModelProvider } from '../src/model';
import {
  Manifest,
  InMemoryMemoryStore,
  memory,
  SandboxAgent,
  type Entry,
  type ExecCommandArgs,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type SandboxDirectoryEntry,
  type SandboxSessionLike,
  type SandboxSessionState,
} from '../src/sandbox';
import { getOrCreateSandboxMemoryGenerationManager } from '../src/sandbox/memory/generation';
import {
  renderMemoryConsolidationPrompt,
  renderMemoryReadPrompt,
  renderRolloutExtractionInstructions,
  renderRolloutExtractionUserPrompt,
} from '../src/sandbox/memory/prompts';
import {
  renderPhaseOnePrompt,
  validateRolloutId,
} from '../src/sandbox/memory/rollouts';
import { SandboxMemoryStorage } from '../src/sandbox/memory/storage';
import { Usage } from '../src/usage';
import { FakeModel, FakeModelProvider, fakeModelMessage } from './stubs';

class MemoryPhaseModelProvider implements ModelProvider {
  readonly calls: string[] = [];

  async getModel(modelName: string): Promise<Model> {
    this.calls.push(modelName);
    if (modelName === 'phase-one-model') {
      return new FakeModel([
        {
          output: [
            fakeModelMessage(
              JSON.stringify({
                rollout_summary: '# Rollout\n\nUsed runner provider.',
                rollout_slug: 'runner-provider',
                raw_memory: '- Use the invoking Runner model provider.',
              }),
            ),
          ],
          usage: new Usage(),
        },
      ]);
    }
    if (modelName === 'phase-two-model') {
      return new FakeModel([
        {
          output: [fakeModelMessage('Consolidated memory.')],
          usage: new Usage(),
        },
      ]);
    }
    throw new Error(`Unexpected model lookup: ${modelName}`);
  }
}

class RecordingFakeModel extends FakeModel {
  readonly requests: Parameters<Model['getResponse']>[0][] = [];

  override async getResponse(
    request: Parameters<Model['getResponse']>[0],
  ): ReturnType<Model['getResponse']> {
    this.requests.push(request);
    return await super.getResponse(request);
  }
}

function createNoopMemoryGenerationConfig(count = 1) {
  return {
    phaseOneModel: new FakeModel(
      Array.from({ length: count }, () => ({
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '',
              rollout_slug: '',
              raw_memory: '',
            }),
          ),
        ],
        usage: new Usage(),
      })),
    ),
    phaseTwoModel: new FakeModel([]),
  };
}

class MemoryEditor implements Editor {
  async createFile(
    _operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    return { output: 'created' };
  }

  async updateFile(
    _operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    return { output: 'updated' };
  }

  async deleteFile(
    _operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    return { output: 'deleted' };
  }
}

class MemorySession implements SandboxSessionLike<SandboxSessionState> {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  readonly execCalls: ExecCommandArgs[] = [];
  readonly pathExistsCalls: Array<{ path: string; runAs?: string }> = [];
  readonly readFileCalls: Array<{
    path: string;
    maxBytes?: number;
    runAs?: string;
  }> = [];
  readonly materializeEntryCalls: MaterializeEntryArgs[] = [];
  readonly listDirCalls: ListDirectoryArgs[] = [];
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };
  runPreStopHooks?: () => Promise<void>;

  createEditor(): Editor {
    return new MemoryEditor();
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    this.execCalls.push(args);
    return 'ok';
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    this.pathExistsCalls.push({ path, runAs });
    return this.files.has(path) || this.dirs.has(path);
  }

  async readFile(args: {
    path: string;
    maxBytes?: number;
    runAs?: string;
  }): Promise<string> {
    this.readFileCalls.push(args);
    const content = this.files.get(args.path);
    if (content === undefined) {
      const error = new Error(`Missing file: ${args.path}`) as Error & {
        code: string;
      };
      error.code = 'ENOENT';
      throw error;
    }
    return typeof args.maxBytes === 'number'
      ? content.slice(0, args.maxBytes)
      : content;
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.materializeEntryCalls.push(args);
    this.state.manifest = new Manifest({
      ...this.state.manifest,
      entries: {
        ...this.state.manifest.entries,
        [args.path]: args.entry,
      },
    });
    this.materialize(args.path, args.entry);
  }

  async listDir(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    this.listDirCalls.push(args);
    const prefix = args.path ? `${args.path}/` : '';
    const names = new Map<string, SandboxDirectoryEntry>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      if (!rest || rest.includes('/')) {
        continue;
      }
      names.set(rest, {
        name: rest,
        path,
        type: this.dirs.has(path) ? 'dir' : 'file',
      });
    }
    return [...names.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async close(): Promise<void> {
    await this.runPreStopHooks?.();
  }

  async applyManifest(manifest: Manifest): Promise<void> {
    this.state.manifest = new Manifest({
      ...this.state.manifest,
      entries: {
        ...this.state.manifest.entries,
        ...manifest.entries,
      },
    });
    for (const [path, entry] of Object.entries(manifest.entries)) {
      this.materialize(path, entry);
    }
  }

  private materialize(path: string, entry: Entry): void {
    if (entry.type === 'dir') {
      this.dirs.add(path);
      for (const [childPath, childEntry] of Object.entries(
        entry.children ?? {},
      )) {
        this.materialize(`${path}/${childPath}`, childEntry);
      }
      return;
    }
    if (entry.type === 'file') {
      this.files.set(
        path,
        typeof entry.content === 'string'
          ? entry.content
          : new TextDecoder().decode(entry.content),
      );
    }
  }
}

class ShellReadOnlySession implements SandboxSessionLike<SandboxSessionState> {
  readonly execCalls: ExecCommandArgs[] = [];
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };

  constructor(private readonly content: string) {}

  async execCommand(args: ExecCommandArgs): Promise<string> {
    this.execCalls.push(args);
    return (
      'Process exited with code 0\n' +
      'Output:\n' +
      `__OPENAI_AGENTS_MEMORY_READ_BEGIN__\n${this.content}` +
      '__OPENAI_AGENTS_MEMORY_READ_STATUS__0' +
      '__OPENAI_AGENTS_MEMORY_READ_END__'
    );
  }
}

class ShellAppendSession implements SandboxSessionLike<SandboxSessionState> {
  readonly execCalls: ExecCommandArgs[] = [];
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };

  async execCommand(args: ExecCommandArgs): Promise<string> {
    this.execCalls.push(args);
    return 'Process exited with code 0\nOutput:\n';
  }
}

class BrokenShellReadSession implements SandboxSessionLike<SandboxSessionState> {
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };

  async execCommand(_args: ExecCommandArgs): Promise<string> {
    return 'Process exited with code 0\nOutput:\nread failed before markers';
  }
}

class MissingShellReadSession implements SandboxSessionLike<SandboxSessionState> {
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };

  async execCommand(_args: ExecCommandArgs): Promise<string> {
    return 'Process exited with code 0\nOutput:\n__OPENAI_AGENTS_MEMORY_READ_MISSING__';
  }
}

class MemorySnapshotClient {
  readonly backendId = 'memory-snapshot';
  readonly session = new MemorySession();
  readonly serializedFiles: Array<Map<string, string>> = [];

  async create(): Promise<MemorySession> {
    return this.session;
  }

  async serializeSessionState(): Promise<Record<string, unknown>> {
    this.serializedFiles.push(new Map(this.session.files));
    return {
      files: Object.fromEntries(this.session.files),
    };
  }

  canPersistOwnedSessionState(): boolean {
    return true;
  }
}

class ReadFileOnlyMissingSession implements SandboxSessionLike<SandboxSessionState> {
  state: SandboxSessionState = {
    manifest: new Manifest(),
  };

  async readFile(args: { path: string }): Promise<string> {
    const error = new Error(`Missing file: ${args.path}`) as Error & {
      code: string;
    };
    error.code = 'ENOENT';
    throw error;
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.state.manifest = new Manifest({
      ...this.state.manifest,
      entries: {
        ...this.state.manifest.entries,
        [args.path]: args.entry,
      },
    });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('Sandbox memory generation', () => {
  beforeEach(() => {
    setDefaultModelProvider(new FakeModelProvider());
  });

  it('validates Python-compatible rollout ids', () => {
    expect(validateRolloutId('abc-123._x')).toBe('abc-123._x');
    expect(() => validateRolloutId('')).toThrow(
      'Sandbox memory rollout ID must be a file-safe ID',
    );
    expect(() => validateRolloutId('../escape')).toThrow(
      'Sandbox memory rollout ID must be a file-safe ID',
    );
    expect(() => validateRolloutId('nested/path')).toThrow(
      'Sandbox memory rollout ID must be a file-safe ID',
    );
  });

  it('renders Python-style memory prompts with extra guidance and selection detail', () => {
    const phaseOne = renderRolloutExtractionInstructions(
      'Remember repository-specific verification commands.',
    );
    expect(phaseOne).toContain('DEVELOPER-SPECIFIC EXTRA GUIDANCE');
    expect(phaseOne).toContain('TASK OUTCOME TRIAGE');
    expect(phaseOne).toContain('`raw_memory` FORMAT (STRICT)');
    expect(phaseOne).toContain('Evidence and attribution rules (strict)');
    expect(phaseOne).toContain(
      'Do not be terse in task sections. Include validation signal, failure mode, reusable procedure,',
    );
    expect(phaseOne).toContain(
      'Return exactly one JSON object with required keys',
    );
    expect(phaseOne).toContain(
      'Remember repository-specific verification commands.',
    );
    expect(renderRolloutExtractionInstructions()).not.toContain(
      'DEVELOPER-SPECIFIC EXTRA GUIDANCE',
    );

    const phaseTwo = renderMemoryConsolidationPrompt({
      memoryRoot: 'memories',
      selection: {
        selected: [
          {
            rolloutId: 'new-rollout',
            updatedAt: '2026-04-19T00:00:00.000Z',
            rolloutPath: 'sessions/new-rollout.jsonl',
            rolloutSummaryFile: 'rollout_summaries/new-rollout_task.md',
            terminalState: 'completed',
          },
          {
            rolloutId: 'retained-rollout',
            updatedAt: '2026-04-18T00:00:00.000Z',
            rolloutPath: 'sessions/retained-rollout.jsonl',
            rolloutSummaryFile: 'rollout_summaries/retained-rollout_task.md',
            terminalState: 'failed',
          },
        ],
        retainedRolloutIds: new Set(['retained-rollout']),
        removed: [
          {
            rolloutId: 'removed-rollout',
            updatedAt: '2026-04-17T00:00:00.000Z',
            rolloutPath: 'sessions/removed-rollout.jsonl',
            rolloutSummaryFile: 'rollout_summaries/removed-rollout_task.md',
            terminalState: 'completed',
          },
        ],
      },
      extraPrompt: 'Prioritize user preferences.',
    });

    expect(phaseTwo).toContain('selected inputs this run: 2');
    expect(phaseTwo).toContain('2) `memory_summary.md` FORMAT (STRICT)');
    expect(phaseTwo).toContain(
      'use update-style edits for these paths, not create-only edits',
    );
    expect(phaseTwo).toContain(
      'for `MEMORY.md` or `memory_summary.md`; use `update_file`',
    );
    expect(phaseTwo).toContain('Recent Active Memory Window behavior');
    expect(phaseTwo).toContain('Evidence deep-dive rule (both modes)');
    expect(phaseTwo).toContain(
      "You should dive deep and make sure you didn't miss any important information",
    );
    expect(phaseTwo).toContain(
      '[added] rollout_id=new-rollout, rollout_summary_file=rollout_summaries/new-rollout_task.md',
    );
    expect(phaseTwo).toContain(
      '[retained] rollout_id=retained-rollout, rollout_summary_file=rollout_summaries/retained-rollout_task.md',
    );
    expect(phaseTwo).toContain(
      'rollout_id=removed-rollout, rollout_summary_file=rollout_summaries/removed-rollout_task.md',
    );
    expect(phaseTwo).toContain('DEVELOPER-SPECIFIC EXTRA GUIDANCE');
    expect(phaseTwo).toContain('Prioritize user preferences.');
  });

  it('matches golden hashes for full Python-style prompt renderers', () => {
    const selection = {
      selected: [
        {
          rolloutId: 'new-rollout',
          updatedAt: '2026-04-19T00:00:00.000+00:00',
          rolloutPath: 'sessions/new-rollout.jsonl',
          rolloutSummaryFile: 'rollout_summaries/new-rollout_task.md',
          terminalState: 'completed',
        },
        {
          rolloutId: 'retained-rollout',
          updatedAt: '2026-04-18T00:00:00.000+00:00',
          rolloutPath: 'sessions/retained-rollout.jsonl',
          rolloutSummaryFile: 'rollout_summaries/retained-rollout_task.md',
          terminalState: 'failed',
        },
      ],
      retainedRolloutIds: new Set(['retained-rollout']),
      removed: [
        {
          rolloutId: 'removed-rollout',
          updatedAt: '2026-04-17T00:00:00.000+00:00',
          rolloutPath: 'sessions/removed-rollout.jsonl',
          rolloutSummaryFile: 'rollout_summaries/removed-rollout_task.md',
          terminalState: 'completed',
        },
      ],
    };

    const cases = [
      [
        'memoryReadLive',
        renderMemoryReadPrompt({
          memoryDir: 'memories',
          memorySummary: 'SUMMARY',
          liveUpdate: true,
        }),
        4036,
        '7d10e5ef754fa56abe26420f8eb7243cb1ddb8bc4279814e1968246ce7c82b7c',
      ],
      [
        'memoryReadOnly',
        renderMemoryReadPrompt({
          memoryDir: 'memories',
          memorySummary: 'SUMMARY',
          liveUpdate: false,
        }),
        3193,
        '75f8252627d3505c4bc88c47f63e3c964897bcc4fcb6a5c622709ef10bba2a93',
      ],
      [
        'phaseOneNoExtra',
        renderRolloutExtractionInstructions(),
        29590,
        '19301489d61f44e8a93328ccbb8600f9e5983f0544427692a0146f460f44dd61',
      ],
      [
        'phaseOneExtra',
        renderRolloutExtractionInstructions('Prioritize user preferences.'),
        30082,
        '200c4c72ba8fb475f009b2e47ecf63e2ac9ee2993e6dc81548bfb783fc413a09',
      ],
      [
        'rolloutUser',
        renderRolloutExtractionUserPrompt({
          terminalMetadataJson: '{"terminal_state":"completed"}',
          rolloutContents: '{"x":1}\n',
        }),
        691,
        '4ad74c829d14dd0cb19caf77cd81bf3d9d4b4e42bc74e6ca406481f5161aec7e',
      ],
      [
        'phaseTwoExtra',
        renderMemoryConsolidationPrompt({
          memoryRoot: 'memories',
          selection,
          extraPrompt: 'Prioritize user preferences.',
        }),
        48128,
        '77cfbac4c5e7b096431ca3e1f3d131f5a8eff6a249cb960c314c057a226eaaba',
      ],
    ] as const;

    for (const [name, rendered, expectedLength, expectedHash] of cases) {
      expect(
        { name, length: rendered.length, sha256: sha256(rendered) },
        name,
      ).toEqual({
        name,
        length: expectedLength,
        sha256: expectedHash,
      });
    }
  });

  it('renders phase-one terminal metadata in Python-compatible JSON format', () => {
    const rendered = renderPhaseOnePrompt(
      `${JSON.stringify({
        terminal_metadata: {
          terminal_state: 'completed',
          has_final_output: true,
          exception_type: null,
          exception_message: null,
        },
      })}\n`,
    );

    expect(rendered).toBe(
      [
        '{',
        '  "exception_message":null,',
        '  "exception_type":null,',
        '  "has_final_output":true,',
        '  "terminal_state":"completed"',
        '}',
      ].join('\n'),
    );
  });

  it('marks and truncates large phase-one rollout prompts with head and tail context', () => {
    const rolloutContents = `${'A'.repeat(720_000)}TAIL_CONTEXT`;
    const rendered = renderRolloutExtractionUserPrompt({
      terminalMetadataJson: '{"terminal_state":"completed"}',
      rolloutContents,
    });

    expect(rendered).toContain('original_chars=');
    expect(rendered).toContain('rendered_chars=');
    expect(rendered).toContain(
      'Do not assume the rendered rollout below is complete.',
    );
    expect(rendered).toContain('TAIL_CONTEXT');
    expect(rendered).toContain('...'); // ASCII truncation marker.
    expect(rendered).not.toContain('…');
  });

  it('rejects conflicting memory generation layouts in one session', () => {
    const session = new MemorySession();
    const runAgent = async () => ({ finalOutput: undefined });
    const base = memory({
      read: false,
      generate: { phaseOneModel: 'a', phaseTwoModel: 'b' },
    });

    getOrCreateSandboxMemoryGenerationManager({
      session,
      memory: base,
      runAgent,
    });

    expect(() =>
      getOrCreateSandboxMemoryGenerationManager({
        session,
        memory: memory({
          read: false,
          generate: { phaseOneModel: 'different', phaseTwoModel: 'b' },
        }),
        runAgent,
      }),
    ).toThrow(
      'Sandbox session already has a different Memory generation config attached for this memory layout.',
    );

    expect(() =>
      getOrCreateSandboxMemoryGenerationManager({
        session,
        memory: memory({
          read: false,
          layout: { memoriesDir: 'memories', sessionsDir: 'other-sessions' },
        }),
        runAgent,
      }),
    ).toThrow(
      'Sandbox session already has a Memory generation capability for memoriesDir=memories.',
    );

    expect(() =>
      getOrCreateSandboxMemoryGenerationManager({
        session,
        memory: memory({
          read: false,
          layout: { memoriesDir: 'other-memories', sessionsDir: 'sessions' },
        }),
        runAgent,
      }),
    ).toThrow(
      'Sandbox session already has a Memory generation capability for sessionsDir=sessions.',
    );
  });

  it('propagates updated runAs to reused memory generation storage', async () => {
    const session = new MemorySession();
    const runAgent = async () => ({ finalOutput: undefined });
    const capability = memory({
      read: false,
      generate: createNoopMemoryGenerationConfig(),
    });

    const manager = getOrCreateSandboxMemoryGenerationManager({
      session,
      memory: capability,
      runAs: 'first-user',
      runAgent,
    });
    const reusedManager = getOrCreateSandboxMemoryGenerationManager({
      session,
      memory: capability,
      runAs: 'second-user',
      runAgent,
    });

    expect(reusedManager).toBe(manager);

    await reusedManager.enqueueState(
      {
        _originalInput: 'Remember the current sandbox user.',
        _generatedItems: [],
        _currentStep: {
          type: 'next_step_final_output',
          output: 'done',
        },
        getInterruptions: () => [],
      } as any,
      {
        rolloutIdentity: {
          groupId: 'shared-run-as-rollout',
        },
      },
    );

    expect(session.materializeEntryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'sessions/shared-run-as-rollout.jsonl',
          runAs: 'second-user',
        }),
      ]),
    );
    expect(
      session.materializeEntryCalls.map((call) => call.runAs),
    ).not.toContain('first-user');
    expect(session.pathExistsCalls.map((call) => call.runAs)).not.toContain(
      'first-user',
    );
  });

  it('persists rollout artifacts and invokes consolidation during cleanup', async () => {
    const session = new MemorySession();
    const phaseOneModel = new RecordingFakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nUsed pnpm for tests.',
              rollout_slug: 'pnpm-tests',
              raw_memory: '- Use `pnpm test` for validation.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    const result = await run(agent, 'Remember the validation command.', {
      sandbox: { session },
    });

    expect(result.finalOutput).toBe('done');
    expect(
      [...session.files.keys()].some((path) => path.startsWith('sessions/')),
    ).toBe(true);
    expect([...session.files.keys()]).toEqual(
      expect.arrayContaining([
        'memories/MEMORY.md',
        'memories/memory_summary.md',
        'memories/raw_memories.md',
        'memories/phase_two_selection.json',
      ]),
    );
    expect(
      [...session.files.keys()].some((path) => path.startsWith('sessions/')),
    ).toBe(true);
    expect(
      [...session.files.keys()].some((path) =>
        path.startsWith('memories/raw_memories/'),
      ),
    ).toBe(true);
    expect(
      [...session.files.keys()].some((path) =>
        path.includes('memories/rollout_summaries/'),
      ),
    ).toBe(true);
    expect(session.files.get('memories/raw_memories.md')).toContain(
      'Use `pnpm test` for validation.',
    );
    expect(session.files.get('memories/raw_memories.md')).not.toMatch(/\n$/);
    expect(session.files.get('memories/phase_two_selection.json')).toContain(
      'pnpm-tests',
    );
    expect(phaseOneModel.requests[0]?.systemInstructions).toContain(
      '# Filesystem',
    );
    expect(phaseTwoModel.requests[0]?.systemInstructions).toContain(
      '# Filesystem',
    );
  });

  it('bounds phase two memory consolidation turns', async () => {
    const session = new MemorySession();
    const calls: Array<{ agentName: string; maxTurns?: number }> = [];
    const runAgent = async (
      agent: { name: string },
      _input: unknown,
      options: { maxTurns?: number },
    ) => {
      calls.push({ agentName: agent.name, maxTurns: options.maxTurns });
      if (agent.name === 'sandbox-memory-phase-one') {
        return {
          finalOutput: {
            rollout_summary: '# Rollout\n\nBounded memory.',
            rollout_slug: 'bounded-memory',
            raw_memory: '- Phase two should run with a turn bound.',
          },
        };
      }
      return { finalOutput: 'Consolidated memory.' };
    };
    const manager = getOrCreateSandboxMemoryGenerationManager({
      session,
      memory: memory({
        read: false,
        generate: {
          phaseOneModel: new FakeModel([]),
          phaseTwoModel: new FakeModel([]),
        },
      }),
      runAgent,
    });

    await manager.enqueueState(
      {
        _originalInput: 'Remember bounded consolidation.',
        _generatedItems: [],
        _currentStep: {
          type: 'next_step_final_output',
          output: 'done',
        },
        getInterruptions: () => [],
      } as any,
      {
        rolloutIdentity: {
          groupId: 'bounded-memory',
        },
      },
    );
    await manager.flush();

    expect(calls).toEqual([
      { agentName: 'sandbox-memory-phase-one', maxTurns: 500 },
      { agentName: 'sandbox-memory-phase-two', maxTurns: 500 },
    ]);
  });

  it('flushes generated memory before serializing owned sessions', async () => {
    const client = new MemorySnapshotClient();
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nSerialized memory.',
              rollout_slug: 'serialized-memory',
              raw_memory: '- Serialized memory survives snapshots.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated serialized memory.')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [fakeModelMessage('done')],
          usage: new Usage(),
        },
      ]),
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    await run(agent, 'Remember serialized memory.', {
      sandbox: { client },
      conversationId: 'serialized-memory',
    });

    expect(client.serializedFiles).toHaveLength(1);
    expect(
      client.serializedFiles[0]?.get('memories/raw_memories.md'),
    ).toContain('Serialized memory survives snapshots.');
  });

  it('flushes and continues recording memory on a reused provided session', async () => {
    const session = new MemorySession();
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nFirst preserved turn.',
              rollout_slug: 'first-preserved-turn',
              raw_memory: '- First memory survives pre-stop.',
            }),
          ),
        ],
        usage: new Usage(),
      },
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nSecond resumed turn.',
              rollout_slug: 'second-resumed-turn',
              raw_memory: '- Second memory records after resume.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated first memory.')],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('Consolidated second memory.')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [fakeModelMessage('first done')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('second done')],
          usage: new Usage(),
        },
      ]),
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    await run(agent, 'Remember the first preserved turn.', {
      sandbox: { session },
      conversationId: 'first-preserved-turn',
    });

    expect(session.files.get('memories/raw_memories.md')).toContain(
      'First memory survives pre-stop.',
    );

    await run(agent, 'Remember the second resumed turn.', {
      sandbox: { session },
      conversationId: 'second-resumed-turn',
    });

    expect(session.files.has('sessions/second-resumed-turn.jsonl')).toBe(true);
    expect(session.files.get('memories/raw_memories.md')).toContain(
      'Second memory records after resume.',
    );
    expect(session.files.get('memories/phase_two_selection.json')).toContain(
      'second-resumed-turn',
    );
  });

  it('filters non-memory-safe input and reasoning items from rollout payloads', async () => {
    const session = new MemorySession();
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [
            {
              type: 'reasoning',
              id: 'reasoning-1',
              content: [{ type: 'input_text', text: 'REASONING_SECRET' }],
              rawContent: [
                { type: 'reasoning_text', text: 'RAW_REASONING_SECRET' },
              ],
            },
            fakeModelMessage('ASSISTANT_KEEP'),
          ],
          usage: new Usage(),
        },
      ]),
      capabilities: [
        memory({
          read: false,
          generate: createNoopMemoryGenerationConfig(),
        }),
      ],
    });

    await run(
      agent,
      [
        { role: 'system', content: 'SYSTEM_SECRET' },
        { role: 'developer', content: 'DEVELOPER_SECRET' },
        { type: 'message', role: 'user', content: 'USER_KEEP' },
        { type: 'compaction', encrypted_content: 'COMPACTION_SECRET' },
        { type: 'unknown', providerData: { value: 'UNKNOWN_SECRET' } },
      ] as any,
      {
        sandbox: { session },
      },
    );

    const rolloutFile = [...session.files.keys()].find(
      (path) => path.startsWith('sessions/') && path.endsWith('.jsonl'),
    );
    expect(rolloutFile).toBeDefined();
    const payload = JSON.parse(session.files.get(rolloutFile!) ?? '{}');
    const serialized = JSON.stringify(payload);

    expect(payload.updated_at).toMatch(/\+00:00$/);
    expect(payload.terminal_metadata).toMatchObject({
      terminal_state: 'completed',
      exception_type: null,
      exception_message: null,
      has_final_output: true,
    });
    expect(serialized).toContain('USER_KEEP');
    expect(serialized).toContain('ASSISTANT_KEEP');
    expect(serialized).not.toContain('SYSTEM_SECRET');
    expect(serialized).not.toContain('DEVELOPER_SECRET');
    expect(serialized).not.toContain('COMPACTION_SECRET');
    expect(serialized).not.toContain('UNKNOWN_SECRET');
    expect(serialized).not.toContain('REASONING_SECRET');
    expect(serialized).not.toContain('RAW_REASONING_SECRET');
  });

  it('clears active memory when handing off to a non-sandbox agent', async () => {
    const session = new MemorySession();
    const nonSandboxAgent = new Agent({
      name: 'non-sandbox',
      model: new FakeModel([
        {
          output: [fakeModelMessage('done outside sandbox')],
          usage: new Usage(),
        },
      ]),
    });
    const handoffToNonSandbox = handoff(nonSandboxAgent);
    const sandboxAgent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [
            {
              type: 'function_call',
              id: 'handoff-1',
              callId: 'handoff-1',
              name: handoffToNonSandbox.toolName,
              status: 'completed',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        },
      ]),
      handoffs: [handoffToNonSandbox],
      capabilities: [
        memory({
          read: false,
          generate: createNoopMemoryGenerationConfig(),
        }),
      ],
    });

    const result = await run(sandboxAgent, 'Remember handoff context.', {
      sandbox: { session },
      conversationId: 'handoff-memory',
    });

    expect(result.finalOutput).toBe('done outside sandbox');
    expect(session.files.has('sessions/handoff-memory.jsonl')).toBe(false);
  });

  it('uses the current session manifest for memory generation phase agents', async () => {
    const session = new MemorySession();
    session.state.manifest = new Manifest({
      root: '/repo',
    });
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nUsed custom roots.',
              rollout_slug: 'custom-roots',
              raw_memory: '- Keep memory generation on the session root.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      defaultManifest: new Manifest({ root: '/repo' }),
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    const result = await run(agent, 'Remember the custom root.', {
      sandbox: { session },
    });

    expect(result.finalOutput).toBe('done');
    await session.close();
    expect(session.files.get('memories/phase_two_selection.json')).toContain(
      'custom-roots',
    );
  });

  it('uses the invoking Runner model provider for memory generation phases', async () => {
    const session = new MemorySession();
    const provider = new MemoryPhaseModelProvider();
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel: 'phase-one-model',
            phaseTwoModel: 'phase-two-model',
          },
        }),
      ],
    });
    const runner = new Runner({
      modelProvider: provider,
    });

    const result = await runner.run(agent, 'Remember the model provider.', {
      sandbox: { session },
    });

    expect(result.finalOutput).toBe('done');
    await session.close();
    expect(provider.calls).toEqual([
      'phase-one-model',
      'phase-one-model',
      'phase-two-model',
      'phase-two-model',
    ]);
    expect(session.files.get('memories/phase_two_selection.json')).toContain(
      'runner-provider',
    );
  });

  it('uses the SDK session id as the rollout id before the runner group id', async () => {
    const sandboxSession = new MemorySession();
    const sdkSession = {
      async getSessionId() {
        return 'sdk-session';
      },
      async getItems() {
        return [];
      },
      async addItems() {},
      async popItem() {
        return undefined;
      },
      async clearSession() {},
    };
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nGrouped by SDK session.',
              rollout_slug: 'sdk-session',
              raw_memory: '- Prefer SDK session grouping for sandbox memory.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });
    const runner = new Runner({ groupId: 'runner-group' });

    await runner.run(agent, 'Remember session grouping.', {
      sandbox: { session: sandboxSession },
      session: sdkSession,
    });
    await sandboxSession.close();

    expect(sandboxSession.files.has('sessions/sdk-session.jsonl')).toBe(true);
    expect(sandboxSession.files.has('sessions/runner-group.jsonl')).toBe(false);
  });

  it('uses conversation id before SDK session id for rollout grouping', async () => {
    const sandboxSession = new MemorySession();
    const sdkSession = {
      async getSessionId() {
        return 'sdk-session';
      },
      async getItems() {
        return [];
      },
      async addItems() {},
      async popItem() {
        return undefined;
      },
      async clearSession() {},
    };
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nGrouped by conversation.',
              rollout_slug: 'conversation-id',
              raw_memory: '- Prefer conversation grouping when provided.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    await run(agent, 'Remember conversation grouping.', {
      sandbox: { session: sandboxSession },
      session: sdkSession,
      conversationId: 'conversation-id',
    });
    await sandboxSession.close();

    expect(sandboxSession.files.has('sessions/conversation-id.jsonl')).toBe(
      true,
    );
    expect(sandboxSession.files.has('sessions/sdk-session.jsonl')).toBe(false);
  });

  it('appends repeated rollout segments as compact JSONL records', async () => {
    const session = new MemorySession();
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [fakeModelMessage('first')],
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('second')],
          usage: new Usage(),
        },
      ]),
      capabilities: [
        memory({
          read: false,
          generate: createNoopMemoryGenerationConfig(2),
        }),
      ],
    });

    await run(agent, 'First turn.', {
      sandbox: { session },
      conversationId: 'same-rollout',
    });
    await run(agent, 'Second turn.', {
      sandbox: { session },
      conversationId: 'same-rollout',
    });

    const contents = session.files.get('sessions/same-rollout.jsonl');
    expect(contents).toBeDefined();
    expect(contents!.split('\n')).toHaveLength(3);
    expect(contents!.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('does not rewrite rollout JSONL from capped reads when appending', async () => {
    const session = new MemorySession();
    const storage = new SandboxMemoryStorage({ session });
    const existing = `${'x'.repeat(1_000_010)}\n`;
    session.files.set('sessions/large.jsonl', existing);

    await storage.appendJsonl('sessions/large.jsonl', { next: true });

    expect(session.files.get('sessions/large.jsonl')).toBe(
      `${existing}${JSON.stringify({ next: true })}\n`,
    );
    await expect(
      storage.readText('sessions/large.jsonl'),
    ).resolves.toHaveLength(1_000_000);
  });

  it('appends rollout JSONL with shell append when direct reads are unavailable', async () => {
    const session = new ShellAppendSession();
    const storage = new SandboxMemoryStorage({ session });

    await storage.appendJsonl('sessions/large.jsonl', { next: true });

    expect(session.execCalls).toHaveLength(1);
    expect(session.execCalls[0]?.cmd).toContain(
      "printf '%s\\n' '{\"next\":true}' >> 'sessions/large.jsonl'",
    );
    expect(session.execCalls[0]?.cmd).not.toContain(
      "cat 'sessions/large.jsonl'",
    );
    expect(session.execCalls[0]?.cmd).not.toContain(
      "head -c 1000000 'sessions/large.jsonl'",
    );
  });

  it('serializes concurrent rollout JSONL appends to the same file', async () => {
    const session = new MemorySession();
    const storage = new SandboxMemoryStorage({ session });

    const originalMaterializeEntry = session.materializeEntry.bind(session);
    let writeCount = 0;
    let firstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    const firstWriteRelease = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    session.materializeEntry = async (
      args: Parameters<MemorySession['materializeEntry']>[0],
    ): ReturnType<MemorySession['materializeEntry']> => {
      if (args.path === 'sessions/shared.jsonl') {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted();
          await firstWriteRelease;
        }
      }
      return await originalMaterializeEntry(args);
    };

    const firstAppend = storage.appendJsonl('sessions/shared.jsonl', {
      turn: 1,
    });
    await firstWrite;
    const secondAppend = storage.appendJsonl('sessions/shared.jsonl', {
      turn: 2,
    });
    await Promise.resolve();
    releaseFirstWrite();

    await Promise.all([firstAppend, secondAppend]);

    expect(session.files.get('sessions/shared.jsonl')).toBe(
      `${JSON.stringify({ turn: 1 })}\n${JSON.stringify({ turn: 2 })}\n`,
    );
  });

  it('preserves exact shell-read text without synthetic marker newlines', async () => {
    const session = new ShellReadOnlySession('  leading\ntrailing');
    const storage = new SandboxMemoryStorage({ session });

    await expect(storage.readText('memories/raw.txt')).resolves.toBe(
      '  leading\ntrailing',
    );
    expect(session.execCalls[0]?.cmd).toContain(
      "printf '%s' '__OPENAI_AGENTS_MEMORY_READ_END__'",
    );
    expect(session.execCalls[0]?.cmd).not.toContain(
      "printf '\\n%s\\n' '__OPENAI_AGENTS_MEMORY_READ_END__'",
    );
  });

  it('does not treat memory content as exec truncation metadata', async () => {
    const session = new ShellReadOnlySession(
      'Original token count: 123\nmemory content',
    );
    const storage = new SandboxMemoryStorage({ session });

    await expect(storage.readText('memories/raw.txt')).resolves.toBe(
      'Original token count: 123\nmemory content',
    );
  });

  it('treats explicit shell-read missing markers as absent files', async () => {
    const session = new MissingShellReadSession();
    const storage = new SandboxMemoryStorage({ session });

    await expect(storage.readText('memories/missing.txt')).resolves.toBeNull();
  });

  it('fails shell-backed reads when framing markers are missing', async () => {
    const session = new BrokenShellReadSession();
    const storage = new SandboxMemoryStorage({ session });

    await expect(storage.readText('memories/raw.txt')).rejects.toThrow(
      'Failed to read memory file "memories/raw.txt" from shell output.',
    );
  });

  it('hydrates memory from an external store and mirrors writes back', async () => {
    const session = new MemorySession();
    const store = new InMemoryMemoryStore();
    await store.write(
      'memories/memory_summary.md',
      new TextEncoder().encode('Stored summary.'),
    );
    await store.write(
      'memories/MEMORY.md',
      new TextEncoder().encode('Stored handbook.'),
    );
    await store.write(
      'memories/live.md',
      new TextEncoder().encode('Stored stale live file.'),
    );
    session.files.set('memories/live.md', 'Workspace live file.');
    const capability = memory({ store });
    capability.bind(session);

    const instructions = await capability.instructions(new Manifest());
    const storage = new SandboxMemoryStorage({ session, store });
    await storage.writeText('memories/MEMORY.md', 'Updated handbook.');

    expect(instructions).toContain('Stored summary.');
    expect(session.files.get('memories/live.md')).toBe('Workspace live file.');
    expect(session.files.get('memories/MEMORY.md')).toBe('Updated handbook.');
    expect(
      new TextDecoder().decode((await store.read('memories/MEMORY.md'))!),
    ).toBe('Updated handbook.');
  });

  it('falls back to the external store when direct sandbox reads miss', async () => {
    const session = new ReadFileOnlyMissingSession();
    const store = new InMemoryMemoryStore();
    await store.write(
      'memories/raw_memories/rollout.md',
      new TextEncoder().encode('Stored raw memory.'),
    );
    const storage = new SandboxMemoryStorage({ session, store });

    await expect(
      storage.readText('memories/raw_memories/rollout.md'),
    ).resolves.toBe('Stored raw memory.');
    await storage.appendJsonl('sessions/from-store.jsonl', { turn: 1 });
    await storage.appendJsonl('sessions/from-store.jsonl', { turn: 2 });

    expect(
      new TextDecoder().decode(
        (await store.read('sessions/from-store.jsonl'))!,
      ),
    ).toBe(`${JSON.stringify({ turn: 1 })}\n${JSON.stringify({ turn: 2 })}\n`);
  });

  it('uses runner group id and generated fallback rollout ids when no session id exists', async () => {
    const groupedSession = new MemorySession();
    const fallbackSession = new MemorySession();
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nGrouped by runner.',
              rollout_slug: 'runner-group',
              raw_memory: '- Prefer group id when no session id exists.',
            }),
          ),
        ],
        usage: new Usage(),
      },
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nUsed fallback id.',
              rollout_slug: 'fallback-id',
              raw_memory:
                '- Generate a file-safe fallback id when no grouping id exists.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated grouped memory.')],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('Consolidated fallback memory.')],
        usage: new Usage(),
      },
    ]);
    const createAgent = (model: Model) =>
      new SandboxAgent({
        name: 'sandbox',
        model,
        capabilities: [
          memory({
            read: false,
            generate: {
              phaseOneModel,
              phaseTwoModel,
            },
          }),
        ],
      });

    await new Runner({ groupId: 'runner-group' }).run(
      createAgent(
        new FakeModel([
          {
            output: [fakeModelMessage('done')],
            usage: new Usage(),
          },
        ]),
      ),
      'Remember group fallback.',
      {
        sandbox: { session: groupedSession },
      },
    );
    await groupedSession.close();

    expect(groupedSession.files.has('sessions/runner-group.jsonl')).toBe(true);

    await run(
      createAgent(
        new FakeModel([
          {
            output: [fakeModelMessage('done')],
            usage: new Usage(),
          },
        ]),
      ),
      'Remember generated fallback.',
      {
        sandbox: { session: fallbackSession },
      },
    );
    await fallbackSession.close();

    const fallbackRolloutFiles = [...fallbackSession.files.keys()].filter(
      (path) => path.startsWith('sessions/') && path.endsWith('.jsonl'),
    );
    expect(fallbackRolloutFiles).toHaveLength(1);
    expect(fallbackRolloutFiles[0]).not.toBe('sessions/runner-group.jsonl');
  });

  it('supports multiple independent memory layouts in one sandbox session', async () => {
    const session = new MemorySession();
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nAgent A memory.',
              rollout_slug: 'agent-a',
              raw_memory: '- Agent A raw memory.',
            }),
          ),
        ],
        usage: new Usage(),
      },
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nAgent B memory.',
              rollout_slug: 'agent-b',
              raw_memory: '- Agent B raw memory.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated agent A memory.')],
        usage: new Usage(),
      },
      {
        output: [fakeModelMessage('Consolidated agent B memory.')],
        usage: new Usage(),
      },
    ]);
    const createAgent = (
      name: string,
      memoriesDir: string,
      sessionsDir: string,
    ) =>
      new SandboxAgent({
        name,
        model: new FakeModel([
          {
            output: [fakeModelMessage('done')],
            usage: new Usage(),
          },
        ]),
        capabilities: [
          memory({
            read: false,
            layout: { memoriesDir, sessionsDir },
            generate: {
              phaseOneModel,
              phaseTwoModel,
            },
          }),
        ],
      });

    await run(
      createAgent('agent-a', 'agent_a_memory', 'agent_a_sessions'),
      'A',
      {
        sandbox: { session },
      },
    );
    await run(
      createAgent('agent-b', 'agent_b_memory', 'agent_b_sessions'),
      'B',
      {
        sandbox: { session },
      },
    );
    await session.close();

    expect(session.files.get('agent_a_memory/raw_memories.md')).toContain(
      'Agent A raw memory.',
    );
    expect(session.files.get('agent_b_memory/raw_memories.md')).toContain(
      'Agent B raw memory.',
    );
  });

  it('marks interrupted runs in the phase-one prompt', async () => {
    const session = new MemorySession();
    const approvalTool = tool({
      name: 'needs_approval',
      description: 'requires approval',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const phaseOneModel = new RecordingFakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nInterrupted for approval.',
              rollout_slug: 'approval-interruption',
              raw_memory: '- Approval interruptions should be marked.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: new FakeModel([
        {
          output: [
            {
              type: 'function_call',
              id: 'approval-1',
              callId: 'approval-1',
              name: 'needs_approval',
              status: 'completed',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        },
      ]),
      tools: [approvalTool],
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    const result = await run(agent, 'Needs approval.', {
      sandbox: { session },
    });

    expect(result.interruptions).toHaveLength(1);
    await session.close();
    expect(JSON.stringify(phaseOneModel.requests[0])).toContain(
      'terminal_state',
    );
    expect(JSON.stringify(phaseOneModel.requests[0])).toContain('interrupted');
  });

  it('skips phase two when phase one returns a no-op extraction', async () => {
    const session = new MemorySession();
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '',
              rollout_slug: '',
              raw_memory: '',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new FakeModel([]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    await run(agent, 'A one-off turn with no durable memory.', {
      sandbox: { session },
    });
    await session.close();

    expect(session.files.has('memories/raw_memories.md')).toBe(false);
    expect(session.files.has('memories/phase_two_selection.json')).toBe(false);
    expect(
      [...session.files.keys()].some((path) =>
        path.startsWith('memories/raw_memories/'),
      ),
    ).toBe(false);
  });

  it('rebuilds phase two selection from newest raw memories and reports removals', async () => {
    const session = new MemorySession();
    session.files.set(
      'memories/raw_memories/old-rollout.md',
      [
        'rollout_id: old-rollout',
        'updated_at: 2000-01-01T00:00:00.000Z',
        'rollout_path: sessions/old-rollout.jsonl',
        'rollout_summary_file: rollout_summaries/old-rollout_old.md',
        'terminal_state: completed',
        '',
        '- Old memory that should be rotated out.',
        '',
      ].join('\n'),
    );
    session.files.set(
      'memories/phase_two_selection.json',
      `${JSON.stringify(
        {
          version: 1,
          updated_at: '2000-01-01T00:00:00.000Z',
          selected: [
            {
              rollout_id: 'old-rollout',
              updated_at: '2000-01-01T00:00:00.000Z',
              rollout_path: 'sessions/old-rollout.jsonl',
              rollout_summary_file: 'rollout_summaries/old-rollout_old.md',
              terminal_state: 'completed',
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const phaseOneModel = new FakeModel([
      {
        output: [
          fakeModelMessage(
            JSON.stringify({
              rollout_summary: '# Rollout\n\nNew memory.',
              rollout_slug: 'new-memory',
              raw_memory: '- New memory should be selected.',
            }),
          ),
        ],
        usage: new Usage(),
      },
    ]);
    const phaseTwoModel = new RecordingFakeModel([
      {
        output: [fakeModelMessage('Consolidated memory.')],
        usage: new Usage(),
      },
    ]);
    const agentModel = new FakeModel([
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      },
    ]);
    const agent = new SandboxAgent({
      name: 'sandbox',
      model: agentModel,
      capabilities: [
        memory({
          read: false,
          generate: {
            maxRawMemoriesForConsolidation: 1,
            phaseOneModel,
            phaseTwoModel,
          },
        }),
      ],
    });

    await run(agent, 'Remember the newest memory.', {
      sandbox: { session },
    });
    await session.close();

    const selection = session.files.get('memories/phase_two_selection.json');
    expect(selection).toContain('new-memory');
    expect(selection).not.toContain('old-rollout');
    expect(session.files.get('memories/raw_memories.md')).toContain(
      'New memory should be selected.',
    );
    expect(session.files.get('memories/raw_memories.md')).not.toContain(
      'Old memory that should be rotated out.',
    );
    expect(JSON.stringify(phaseTwoModel.requests[0])).toContain(
      'rollout_id=old-rollout',
    );
  });
});
