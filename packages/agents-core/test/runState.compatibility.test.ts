import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import type { ModelRequest, ModelResponse } from '../src/model';
import { Runner } from '../src/run';
import {
  CURRENT_SCHEMA_VERSION,
  RunState,
  SUPPORTED_SCHEMA_VERSIONS,
} from '../src/runState';
import { setDefaultModelProvider } from '../src/providers';
import { tool } from '../src/tool';
import { Usage } from '../src/usage';
import { ScriptedModel, modelResponse } from '../src/testing';

type FixtureRecord = {
  scenario: string;
  kind: 'minimal' | 'feature' | 'resume';
  path: string;
  sha256: string;
};

type WriterSchema = {
  schemaVersion: string;
  status: 'published_writer';
  packageVersion: string;
  tag: string;
  commit: string;
  npmIntegrity: string;
  fixtures: FixtureRecord[];
};

type PolicySchema = {
  schemaVersion: string;
  status: 'published_reader_only' | 'current_unreleased';
  reason: string;
};

type NegativeFixture = {
  scenario: string;
  path: string;
  sha256: string;
  expectedError: string;
};

type CorpusManifest = {
  formatVersion: number;
  currentSchemaAtCreation: string;
  schemas: Array<WriterSchema | PolicySchema>;
  expectedNormalizedFixtures: Array<{
    sourceSchemaVersion: string;
    path: string;
    sha256: string;
  }>;
  negativeFixtures: NegativeFixture[];
};

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'run-state',
);
const manifest = readJson<CorpusManifest>('sources.json');

class QueueModel extends ScriptedModel {
  constructor(outputs: ModelResponse['output'][]) {
    super(
      outputs.map((output) => modelResponse({ output, usage: new Usage() })),
    );
  }

  get requests(): readonly Readonly<ModelRequest>[] {
    return this.calls.map((call) => call.request);
  }
}

beforeAll(() => {
  setDefaultModelProvider({
    getModel() {
      throw new Error(
        'Compatibility-test agents require an explicit fake model.',
      );
    },
  });
});

describe('historical RunState compatibility corpus', () => {
  it('accounts for every supported schema with explicit release policy', () => {
    expect(manifest.currentSchemaAtCreation).toBe(CURRENT_SCHEMA_VERSION);
    expect(manifest.schemas.map((entry) => entry.schemaVersion)).toEqual([
      ...SUPPORTED_SCHEMA_VERSIONS,
    ]);

    const writerVersions = manifest.schemas
      .filter(
        (entry): entry is WriterSchema => entry.status === 'published_writer',
      )
      .map((entry) => entry.schemaVersion);
    expect(writerVersions).toEqual([
      '1.0',
      '1.1',
      '1.2',
      '1.4',
      '1.5',
      '1.6',
      '1.7',
      '1.8',
      '1.9',
      '1.10',
      '1.11',
      '1.12',
      '1.13',
      '1.14',
      '1.15',
      '1.17',
    ]);
    expect(
      manifest.schemas
        .filter((entry) => entry.status === 'published_reader_only')
        .map((entry) => entry.schemaVersion),
    ).toEqual(['1.3', '1.16']);
    expect(
      manifest.schemas
        .filter((entry) => entry.status === 'current_unreleased')
        .map((entry) => entry.schemaVersion),
    ).toEqual(['1.18']);
  });

  it('pins every fixture to immutable bytes and complete writer provenance', () => {
    for (const source of writerSources()) {
      expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(source.tag).toBe(`v${source.packageVersion}`);
      expect(source.npmIntegrity).toMatch(/^sha512-/);
      expect(
        source.fixtures.filter((fixture) => fixture.kind === 'minimal'),
      ).toHaveLength(1);
      for (const fixture of source.fixtures) {
        expect(hashFixture(fixture.path)).toBe(fixture.sha256);
        expect(
          readJson<Record<string, unknown>>(fixture.path).$schemaVersion,
        ).toBe(source.schemaVersion);
      }
    }
    for (const fixture of manifest.negativeFixtures) {
      expect(hashFixture(fixture.path)).toBe(fixture.sha256);
    }
    for (const fixture of manifest.expectedNormalizedFixtures) {
      expect(hashFixture(fixture.path)).toBe(fixture.sha256);
    }
  });

  it.each(
    writerSources().map((source) => [source.schemaVersion, source] as const),
  )(
    'reads, normalizes, and idempotently rewrites released minimal schema %s',
    async (_schemaVersion, source) => {
      const fixture = source.fixtures.find(
        (candidate) => candidate.kind === 'minimal',
      );
      expect(fixture).toBeDefined();
      const bytes = readFixture(fixture!.path);
      const historical = JSON.parse(bytes) as Record<string, unknown>;
      const agent = new Agent({ name: 'HistoricalAgent' });

      const restored = await RunState.fromString(agent, bytes);
      expect(restored._currentTurn).toBe(historical.currentTurn);
      expect(restored._originalInput).toEqual(historical.originalInput);
      expect(restored._maxTurns).toBe(historical.maxTurns);
      expect(restored._context.context).toEqual({ fixture: 'minimal' });

      const firstRewrite = JSON.parse(restored.toString()) as Record<
        string,
        unknown
      >;
      if (source.schemaVersion === '1.0') {
        expect(firstRewrite).toEqual(
          readJson('expected/v1.0-normalized-current.json'),
        );
      }
      expect(firstRewrite.$schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expectJsonScalars(firstRewrite);

      const rewritten = await RunState.fromString(
        agent,
        JSON.stringify(firstRewrite),
      );
      expect(JSON.parse(rewritten.toString())).toEqual(firstRewrite);
    },
  );

  it('preserves released mid-turn server continuation identifiers', async () => {
    const restored = await RunState.fromString(
      new Agent({ name: 'HistoricalAgent' }),
      readFixture('historical/v1.1-server-continuation.json'),
    );

    expect(restored._currentTurnInProgress).toBe(true);
    expect(restored._conversationId).toBe('conversation-historical');
    expect(restored._previousResponseId).toBe('response-historical');
  });

  it('approves and resumes a released nested-agent interruption', async () => {
    let executions = 0;
    const { outerAgent, outerModel } = createNestedApprovalAgents(() => {
      executions += 1;
    });
    const restored = await RunState.fromString(
      outerAgent,
      readFixture('historical/v1.2-nested-approval.json'),
    );
    const approval = restored.getInterruptions()[0];
    expect(approval?.agent.name).toBe('NestedAgent');

    restored.approve(approval!);
    const result = await new Runner().run(outerAgent, restored);

    expect(result.finalOutput).toBe('Outer done');
    expect(result.interruptions).toEqual([]);
    expect(executions).toBe(1);
    expect(outerModel.requests).toHaveLength(1);
  });

  it('rejects and resumes a released nested-agent interruption', async () => {
    let executions = 0;
    const { outerAgent } = createNestedApprovalAgents(() => {
      executions += 1;
    });
    const restored = await RunState.fromString(
      outerAgent,
      readFixture('historical/v1.2-nested-approval.json'),
    );
    const approval = restored.getInterruptions()[0];

    restored.reject(approval!);
    const result = await new Runner().run(outerAgent, restored);

    expect(result.finalOutput).toBe('Outer done');
    expect(result.interruptions).toEqual([]);
    expect(executions).toBe(0);
  });

  it('resumes after a released committed side effect without executing it again', async () => {
    let executions = 0;
    const finalModel = new QueueModel([[message('done')]]);
    const sideEffectTool = tool({
      name: 'side_effect_tool',
      description: 'Runs once.',
      parameters: z.object({}).strict(),
      execute: async () => {
        executions += 1;
        return 'unexpected duplicate';
      },
    });
    const agent = new Agent({
      name: 'SideEffectAgent',
      model: finalModel,
      tools: [sideEffectTool],
    });
    const restored = await RunState.fromString(
      agent,
      readFixture('historical/v1.17-side-effect-committed.json'),
    );

    const result = await new Runner().run(agent, restored);

    expect(result.finalOutput).toBe('done');
    expect(executions).toBe(0);
    expect(finalModel.requests).toHaveLength(1);
    const resumedInput = finalModel.requests[0]!.input;
    expect(Array.isArray(resumedInput)).toBe(true);
    if (!Array.isArray(resumedInput)) {
      throw new Error('Expected resumed model input to be an item array.');
    }
    expect(
      resumedInput.filter(
        (item) =>
          item.type === 'function_call' && item.callId === 'side-effect-call',
      ),
    ).toHaveLength(1);
    expect(
      resumedInput.filter(
        (item) =>
          item.type === 'function_call_result' &&
          item.callId === 'side-effect-call' &&
          item.output === 'side effect completed',
      ),
    ).toHaveLength(1);
  });

  it.each(manifest.negativeFixtures.filter((fixture) => fixture.expectedError))(
    'rejects negative fixture $scenario before side effects',
    async (fixture) => {
      let toolCalls = 0;
      const model = new ScriptedModel([
        modelResponse({
          output: [message('unexpected')],
          usage: new Usage(),
        }),
      ]);
      const agent = new Agent({
        name: 'HistoricalAgent',
        model,
        tools: [
          tool({
            name: 'side_effect_tool',
            description: 'Must not run.',
            parameters: z.object({}).strict(),
            execute: async () => {
              toolCalls += 1;
              return 'unexpected';
            },
          }),
        ],
      });

      await expect(
        RunState.fromString(agent, readFixture(fixture.path)),
      ).rejects.toThrow(fixture.expectedError);
      expect(model.calls).toHaveLength(0);
      expect(toolCalls).toBe(0);
    },
  );

  it('parses an own __proto__ key without polluting object prototypes', async () => {
    expect(
      (Object.prototype as { polluted?: unknown }).polluted,
    ).toBeUndefined();
    const restored = await RunState.fromString(
      new Agent({ name: 'HistoricalAgent' }),
      readFixture('negative/prototype-key.json'),
    );
    const context = restored._context.context as Record<string, unknown>;
    expect(context.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(context)).toBe(Object.prototype);
    expect(
      (Object.prototype as { polluted?: unknown }).polluted,
    ).toBeUndefined();
  });
});

function writerSources(): WriterSchema[] {
  return manifest.schemas.filter(
    (entry): entry is WriterSchema => entry.status === 'published_writer',
  );
}

function readFixture(relativePath: string): string {
  return readFileSync(join(fixtureRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFixture(relativePath)) as T;
}

function hashFixture(relativePath: string): string {
  return createHash('sha256').update(readFixture(relativePath)).digest('hex');
}

function expectJsonScalars(value: unknown): void {
  if (value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      expectJsonScalars(item);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      expectJsonScalars(item);
    }
    return;
  }
  expect(['string', 'number', 'boolean']).toContain(typeof value);
  if (typeof value === 'number') {
    expect(Number.isFinite(value)).toBe(true);
  }
}

function createNestedApprovalAgents(onExecute: () => void) {
  const approvalTool = tool({
    name: 'secure_tool',
    description: 'Requires approval.',
    parameters: z.object({ text: z.string() }),
    needsApproval: true,
    execute: async ({ text }) => {
      onExecute();
      return `approved:${text}`;
    },
  });
  const nestedAgent = new Agent({
    name: 'NestedAgent',
    model: new QueueModel([[message('Nested done')]]),
    tools: [approvalTool],
    modelSettings: { toolChoice: 'required' },
  });
  const nestedTool = nestedAgent.asTool({
    toolName: 'nested_tool',
    toolDescription: 'Nested agent tool.',
    runOptions: { context: { nested: true } },
  });
  const outerModel = new QueueModel([[message('Outer done')]]);
  const outerAgent = new Agent({
    name: 'OuterAgent',
    model: outerModel,
    tools: [nestedTool],
    modelSettings: { toolChoice: 'required' },
  });
  return { outerAgent, outerModel };
}

function message(text: string): ModelResponse['output'][number] {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}
