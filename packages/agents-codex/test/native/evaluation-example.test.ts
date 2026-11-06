import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, type Session } from '@openai/agents';
import * as scripted from '@openai/agents/testing';
import { evaluate, main } from '../../../../examples/codex/evaluation/run';
import * as scoring from '../../../../examples/codex/evaluation/scoring';

const config = scoring.configurationSchema.parse({
  model: 'gpt-5.1',
  instructions: 'Use lookup and answer with its catalog value.',
  reasoningEffort: 'low',
  timeoutMs: 8_000,
});
const cases: scoring.Case[] = [
  {
    id: 'known',
    prompt: 'Look up code A.',
    expectedAnswer: 'violet',
    expectedLookups: ['A'],
  },
  {
    id: 'absent',
    prompt: 'Look up code Z.',
    expectedAnswer: 'UNKNOWN',
    expectedLookups: ['Z'],
  },
];
const allTrue = { completed: true, answerExact: true, toolBehavior: true };
const allFalse = { completed: false, answerExact: false, toolBehavior: false };
const privateMessage = 'PRIVATE_EVALUATION_ERROR_DO_NOT_SERIALIZE';
const folders: string[] = [];

async function temporaryFolder() {
  const folder = await mkdtemp(join(tmpdir(), 'agents-evaluation-test-'));
  folders.push(folder);
  return folder;
}

// Pure artifact fixtures exercise validation and comparison, not native execution.
function baseline(
  selectedCases = cases,
  repeats = 1,
  mode: scoring.Mode = 'scripted',
): scoring.Artifact {
  return {
    formatVersion: 1,
    scorerIdentity: scoring.SCORER_IDENTITY,
    mode,
    evidence: mode === 'scripted' ? 'harness_only' : 'live_model_trials',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: {
      revision: '0'.repeat(40),
      dirty: false,
      exampleSha256: '0'.repeat(64),
    },
    sdkVersion: 'test-fixture',
    nodeVersion: process.versions.node,
    config: structuredClone(config),
    configSha256: scoring.hashJson(config),
    cases: structuredClone(selectedCases),
    casesSha256: scoring.hashJson(selectedCases),
    catalog: { A: 'violet', B: 'amber' },
    catalogSha256: scoring.hashJson({ A: 'violet', B: 'amber' }),
    repeats,
    trials: selectedCases.flatMap((testCase) =>
      Array.from({ length: repeats }, (_, index) => ({
        caseId: testCase.id,
        repeat: index + 1,
        answer: testCase.expectedAnswer,
        effects: testCase.expectedLookups.map((code) => ({
          code,
          output: code === 'A' ? 'violet' : code === 'B' ? 'amber' : 'UNKNOWN',
        })),
        errors: [],
        elapsedMs: 1,
        scores: { ...allTrue },
        passed: true,
      })),
    ),
    aborted: false,
    errors: [],
  };
}

function observePeers(
  select: (
    responses: readonly scripted.ScriptedResponse[],
    index: number,
  ) => readonly scripted.ScriptedResponse[] = (responses) => responses,
) {
  const original = scripted.withScriptedResponses;
  const peers: {
    provider: NativeProvider;
    requests: scripted.ScriptedResponses['requests'];
    outputs: Record<string, string | undefined>;
  }[] = [];
  vi.spyOn(scripted, 'withScriptedResponses').mockImplementation(
    (responses, run) =>
      original(select(responses, peers.length), async (peer) => {
        const observation = {
          provider: peer.provider,
          requests: [] as scripted.ScriptedResponses['requests'],
          outputs: {} as Record<string, string | undefined>,
        };
        peers.push(observation);
        try {
          return await run(peer);
        } finally {
          observation.requests = peer.requests;
          for (const response of responses) {
            if (!Array.isArray(response)) continue;
            for (const item of response) {
              if (item.type === 'function_call')
                observation.outputs[item.call_id] = peer.toolOutput(
                  item.call_id,
                );
            }
          }
        }
      }),
  );
  return peers;
}

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Fail before native admission if a supposedly scripted trial selects live work.
  const open = Agent.prototype.session;
  vi.spyOn(Agent.prototype, 'session').mockImplementation(function (
    this: Agent,
    ...args
  ) {
    expect(this.provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(this.provider.apiKey).toBe('scripted-test-key');
    return open.apply(this, args);
  });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native evaluation lesson',
  () => {
    it('runs the shipped no-key cases twice through real lookup callbacks and native receipts', async () => {
      const folder = resolve(
        __dirname,
        '../../../../examples/codex/evaluation',
      );
      const shippedConfig = scoring.configurationSchema.parse(
        JSON.parse(await readFile(join(folder, 'config.json'), 'utf8')),
      );
      const shippedCases = scoring.casesSchema.parse(
        JSON.parse(await readFile(join(folder, 'cases.json'), 'utf8')),
      );
      const peers = observePeers();
      const close = vi.spyOn(NativeProvider.prototype, 'close');
      const artifact = await evaluate({
        config: shippedConfig,
        cases: shippedCases,
        repeats: 2,
      });

      expect(artifact.evidence).toBe('harness_only');
      expect(artifact.config).toEqual(shippedConfig);
      expect(
        artifact.trials.map(({ caseId, repeat }) => [caseId, repeat]),
      ).toEqual([
        ['known', 1],
        ['known', 2],
        ['absent', 1],
        ['absent', 2],
      ]);
      expect(artifact.trials.map(({ effects }) => effects)).toEqual([
        [{ code: 'A', output: 'violet' }],
        [{ code: 'A', output: 'violet' }],
        [{ code: 'Z', output: 'UNKNOWN' }],
        [{ code: 'Z', output: 'UNKNOWN' }],
      ]);
      expect(artifact.trials.map(({ answer }) => answer)).toEqual([
        'violet',
        'violet',
        'UNKNOWN',
        'UNKNOWN',
      ]);
      expect(
        artifact.trials.every(
          (trial) => trial.passed && trial.errors.length === 0,
        ),
      ).toBe(true);
      expect(artifact.aborted).toBe(false);
      expect(artifact.source.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(artifact.source.exampleSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof artifact.source.dirty).toBe('boolean');
      expect(peers).toHaveLength(4);
      expect(close).toHaveBeenCalledTimes(4);
      for (const [index, peer] of peers.entries()) {
        expect(peer.requests).toHaveLength(2);
        expect(
          peer.requests.every(
            (request) => request.model === shippedConfig.model,
          ),
        ).toBe(true);
        expect(peer.requests[0].reasoning).toMatchObject({
          effort: shippedConfig.reasoningEffort,
        });
        expect(JSON.stringify(peer.requests[0])).toContain(
          shippedCases[index < 2 ? 0 : 1].prompt,
        );
        expect(Object.values(peer.outputs)).toEqual([
          index < 2 ? 'violet' : 'UNKNOWN',
        ]);
        expect(JSON.stringify(peer.requests[1].input)).toContain(
          'function_call_output',
        );
      }
      expect(scoring.compareArtifacts(artifact, artifact)).toMatchObject({
        regressions: [],
        passedTrialDelta: 0,
      });
      expect(JSON.stringify(artifact)).not.toContain('scripted-test-key');
    }, 45_000);

    it('writes a real native provider failure, retains the next trial and returns CLI failure', async () => {
      const peers = observePeers((responses, index) =>
        index === 0
          ? [
              scripted.httpError(400, {
                error: {
                  message: privateMessage,
                  type: 'invalid_request_error',
                },
              }),
            ]
          : responses,
      );
      const close = vi.spyOn(NativeProvider.prototype, 'close');
      const output = join(await temporaryFolder(), 'failed.json');
      expect(await main(['--output', output])).toBe(1);
      const artifact = scoring.artifactSchema.parse(
        JSON.parse(await readFile(output, 'utf8')),
      );
      expect(artifact.trials).toHaveLength(2);
      expect(artifact.trials[0]).toMatchObject({
        answer: null,
        effects: [],
        errors: [{ kind: 'native' }],
        scores: allFalse,
        passed: false,
      });
      expect(artifact.trials[1]).toMatchObject({
        effects: [{ code: 'Z', output: 'UNKNOWN' }],
        scores: allTrue,
        passed: true,
      });
      expect(artifact.aborted).toBe(false);
      expect(peers.map(({ requests }) => requests.length)).toEqual([1, 2]);
      expect(close).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(artifact)).not.toContain(privateMessage);
      expect(
        JSON.stringify(
          peers.map(({ requests, outputs }) => ({ requests, outputs })),
        ),
      ).not.toContain(privateMessage);
    }, 30_000);

    it('fails a real throwing lookup even if Core later returns the scripted correct answer', async () => {
      const peers = observePeers();
      const close = vi.spyOn(NativeProvider.prototype, 'close');
      const lookup = vi
        .spyOn(scoring, 'catalogValue')
        .mockImplementationOnce(() => {
          throw new Error(privateMessage);
        });
      const artifact = await evaluate({ config, cases });
      expect(lookup.mock.calls[0]).toEqual(['A']);
      expect(peers[0].requests.length).toBeGreaterThanOrEqual(1);
      expect(artifact.trials[0]).toMatchObject({
        effects: [],
        scores: allFalse,
        passed: false,
      });
      expect(artifact.trials[0].errors).toContainEqual({ kind: 'tool' });
      expect(artifact.trials[1]).toMatchObject({
        effects: [{ code: 'Z', output: 'UNKNOWN' }],
        passed: true,
      });
      expect(artifact.aborted).toBe(false);
      expect(close).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(artifact)).not.toContain(privateMessage);
      expect(
        JSON.stringify(
          peers.map(({ requests, outputs }) => ({ requests, outputs })),
        ),
      ).not.toContain(privateMessage);
    }, 30_000);

    it('hashes nested parsed values canonically while retaining array order', () => {
      const bytes = '{"a":[2,1],"b":{"c":1,"d":2}}';
      expect(scoring.hashJson({ b: { d: 2, c: 1 }, a: [2, 1] })).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(scoring.hashJson({ a: [1, 2], b: { c: 1, d: 2 } })).not.toBe(
        scoring.hashJson({ a: [2, 1], b: { c: 1, d: 2 } }),
      );
    });

    it.each([
      [
        'wrong answer',
        'amber',
        [
          { code: 'A', output: 'violet' },
          { code: 'B', output: 'amber' },
        ],
        { completed: true, answerExact: false, toolBehavior: true },
      ],
      [
        'duplicate lookup',
        'violet amber',
        [
          { code: 'A', output: 'violet' },
          { code: 'B', output: 'amber' },
          { code: 'B', output: 'amber' },
        ],
        { completed: true, answerExact: true, toolBehavior: false },
      ],
      [
        'missing lookup',
        'violet amber',
        [{ code: 'A', output: 'violet' }],
        { completed: true, answerExact: true, toolBehavior: false },
      ],
      [
        'reordered lookups',
        'violet amber',
        [
          { code: 'B', output: 'amber' },
          { code: 'A', output: 'violet' },
        ],
        { completed: true, answerExact: true, toolBehavior: false },
      ],
      [
        'wrong value',
        'violet amber',
        [
          { code: 'A', output: 'amber' },
          { code: 'B', output: 'amber' },
        ],
        { completed: true, answerExact: true, toolBehavior: false },
      ],
      [
        'surrounding whitespace',
        '\n violet amber \t',
        [
          { code: 'A', output: 'violet' },
          { code: 'B', output: 'amber' },
        ],
        allTrue,
      ],
      [
        'internal whitespace',
        'violet  amber',
        [
          { code: 'A', output: 'violet' },
          { code: 'B', output: 'amber' },
        ],
        { completed: true, answerExact: false, toolBehavior: true },
      ],
    ] as const)(
      'scores %s independently',
      (_label, answer, effects, expected) => {
        const testCase = {
          ...cases[0],
          expectedAnswer: '  violet amber\n',
          expectedLookups: ['A', 'B'],
        };
        expect(scoring.scoreTrial(answer, effects, testCase, [])).toEqual(
          expected,
        );
        expect(
          scoring.scoreTrial(answer, effects, testCase, [{ kind: 'timeout' }]),
        ).toEqual(allFalse);
      },
    );

    it('reports an actual-effect regression and permits configuration-only changes', () => {
      const prior = baseline();
      const current = structuredClone(prior);
      current.config.instructions = 'A different candidate prompt.';
      current.configSha256 = scoring.hashJson(current.config);
      current.trials[0].effects.push({ code: 'A', output: 'violet' });
      current.trials[0].scores.toolBehavior = false;
      current.trials[0].passed = false;
      expect(scoring.compareArtifacts(current, prior)).toEqual({
        baselineConfigSha256: prior.configSha256,
        baselineSource: prior.source,
        regressions: [{ caseId: 'known', repeat: 1, score: 'toolBehavior' }],
        passedTrialDelta: -1,
      });
    });

    const incompatible: [string, (value: scoring.Artifact) => void][] = [
      [
        'mixed evidence',
        (value) => {
          value.mode = 'live';
          value.evidence = 'live_model_trials';
        },
      ],
      [
        'different cases',
        (value) => {
          value.cases[0].prompt = 'Changed prompt';
          value.casesSha256 = scoring.hashJson(value.cases);
        },
      ],
      [
        'stale embedded case hash',
        (value) => {
          value.cases[0].prompt = 'Changed prompt without updating hash';
        },
      ],
      [
        'stale embedded config hash',
        (value) => {
          value.config.instructions = 'Changed instructions';
        },
      ],
      [
        'stale embedded catalog hash',
        (value) => {
          value.catalog.A = 'Changed value';
        },
      ],
      [
        'different repeats',
        (value) => {
          value.repeats = 2;
          value.trials.push(
            ...structuredClone(value.trials).map((trial) => ({
              ...trial,
              repeat: 2,
            })),
          );
        },
      ],
      [
        'different scorer',
        (value) => {
          Object.assign(value, { scorerIdentity: 'another-scorer' });
        },
      ],
      [
        'unknown format',
        (value) => {
          Object.assign(value, { formatVersion: 2 });
        },
      ],
      [
        'duplicate identity',
        (value) => {
          value.trials[1] = structuredClone(value.trials[0]);
        },
      ],
      [
        'missing identity',
        (value) => {
          value.trials.pop();
        },
      ],
      [
        'inconsistent scores',
        (value) => {
          value.trials[0].scores.answerExact = false;
          value.trials[0].passed = false;
        },
      ],
      [
        'inconsistent passed flag',
        (value) => {
          value.trials[0].passed = false;
        },
      ],
      [
        'aborted complete grid',
        (value) => {
          value.aborted = true;
          value.errors.push({ kind: 'cleanup' });
        },
      ],
    ];

    it.each(incompatible)(
      'refuses baseline %s before any provider or Session work',
      async (_label, mutate) => {
        const prior = baseline();
        mutate(prior);
        const peer = vi.spyOn(scripted, 'withScriptedResponses');
        const close = vi.spyOn(NativeProvider.prototype, 'close');
        await expect(
          evaluate({ config, cases, baseline: prior }),
        ).rejects.toThrow();
        expect(Agent.prototype.session).not.toHaveBeenCalled();
        expect(peer).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, '', '  '])(
      'refuses live mode with missing/blank credentials %s before resources',
      async (key) => {
        vi.stubEnv('OPENAI_API_KEY', key);
        const peer = vi.spyOn(scripted, 'withScriptedResponses');
        await expect(evaluate({ config, cases, mode: 'live' })).rejects.toThrow(
          'OPENAI_API_KEY',
        );
        expect(Agent.prototype.session).not.toHaveBeenCalled();
        expect(peer).not.toHaveBeenCalled();
      },
    );

    it('rejects invalid CLI inputs without writing an artifact or opening native work', async () => {
      const folder = await temporaryFolder();
      const output = join(folder, 'not-created.json');
      const invalidBaseline = join(folder, 'baseline.json');
      await writeFile(invalidBaseline, '{"formatVersion":999}');
      await expect(
        main(['--output', output, '--baseline', invalidBaseline]),
      ).rejects.toThrow();
      await expect(
        main(['--output', output, '--mode', 'live']),
      ).rejects.toThrow('OPENAI_API_KEY');
      await expect(
        main(['--output', output, '--unknown-option']),
      ).rejects.toThrow();
      await expect(readFile(output, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(Agent.prototype.session).not.toHaveBeenCalled();
    });

    // Public lifecycle doubles control delivery only; these cases execute no Core
    // or network work, even though they select the runner's live ownership branch.
    function ownedSession() {
      const answer = Promise.withResolvers<{ finalOutput: string }>();
      const waiting = Promise.withResolvers<void>();
      const closing = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      const events: string[] = [];
      const turn = {
        wait: () => {
          waiting.resolve();
          return answer.promise;
        },
      };
      const session = {
        submit: vi.fn(async () => turn),
        close: vi.fn(async () => {
          events.push('session.close.begin');
          closing.resolve();
          await cleanup.promise;
          answer.reject(new Error(privateMessage));
          events.push('session.close.end');
        }),
      };
      vi.mocked(Agent.prototype.session).mockResolvedValue(
        session as unknown as Session,
      );
      const providerClose = vi
        .spyOn(NativeProvider.prototype, 'close')
        .mockImplementation(async () => {
          events.push('provider.close');
        });
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-evaluation-lifecycle-key');
      return {
        answer,
        waiting,
        closing,
        cleanup,
        events,
        turn,
        session,
        providerClose,
      };
    }

    it('starts only the result-wait deadline after submit and joins delayed cleanup', async () => {
      vi.useFakeTimers();
      let clock = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const owned = ownedSession();
      const opening = Promise.withResolvers<Session>();
      const openingEntered = Promise.withResolvers<void>();
      const submitting = Promise.withResolvers<void>();
      const admitted = Promise.withResolvers<typeof owned.turn>();
      vi.mocked(Agent.prototype.session).mockImplementation(() => {
        openingEntered.resolve();
        return opening.promise;
      });
      owned.session.submit.mockImplementation(() => {
        submitting.resolve();
        return admitted.promise;
      });
      const noTools = [{ ...cases[0], expectedLookups: [] }];
      let settled = false;
      const running = evaluate({
        config: { ...config, timeoutMs: 30 },
        cases: noTools,
        mode: 'live',
      }).finally(() => {
        settled = true;
      });
      try {
        await openingEntered.promise;
        await vi.advanceTimersByTimeAsync(100);
        expect(vi.getTimerCount()).toBe(0);
        opening.resolve(owned.session as unknown as Session);
        await submitting.promise;
        await vi.advanceTimersByTimeAsync(100);
        expect(vi.getTimerCount()).toBe(0);
        admitted.resolve(owned.turn);
        await owned.waiting.promise;
        clock = 30;
        await vi.advanceTimersByTimeAsync(30);
        await owned.closing.promise;
        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(owned.providerClose).not.toHaveBeenCalled();
        clock = 230;
        owned.cleanup.resolve();
        const artifact = await running;
        expect(artifact.trials[0]).toMatchObject({
          errors: [{ kind: 'timeout' }],
          scores: allFalse,
          elapsedMs: 230,
        });
        expect(artifact.aborted).toBe(false);
        expect(owned.events).toEqual([
          'session.close.begin',
          'session.close.end',
          'provider.close',
        ]);
        expect(JSON.stringify(artifact)).not.toContain(privateMessage);
      } finally {
        opening.resolve(owned.session as unknown as Session);
        admitted.resolve(owned.turn);
        owned.answer.resolve({ finalOutput: 'violet' });
        owned.cleanup.resolve();
        await running;
      }
    });

    it.each([
      { timeout: false, repeats: 1 },
      { timeout: true, repeats: 2 },
    ])(
      'retains cleanup failures and stops the grid (timeout=$timeout, repeats=$repeats)',
      async ({ timeout, repeats }) => {
        vi.useFakeTimers();
        const owned = ownedSession();
        const close = owned.session.close.getMockImplementation()!;
        owned.session.close.mockImplementation(async () => {
          await close();
          throw new Error(privateMessage);
        });
        owned.providerClose.mockImplementation(async () => {
          owned.events.push('provider.close');
          throw new Error(privateMessage);
        });
        const noTools = [{ ...cases[0], expectedLookups: [] }];
        const prior = baseline(noTools, repeats, 'live');
        const running = evaluate({
          config: { ...config, timeoutMs: 30 },
          cases: noTools,
          mode: 'live',
          repeats,
          baseline: prior,
        });
        try {
          await owned.waiting.promise;
          if (timeout) await vi.advanceTimersByTimeAsync(30);
          else owned.answer.resolve({ finalOutput: 'violet' });
          await owned.closing.promise;
          expect(owned.providerClose).not.toHaveBeenCalled();
          owned.cleanup.resolve();
          const artifact = await running;
          expect(artifact.aborted).toBe(true);
          expect(artifact.trials).toHaveLength(1);
          expect(artifact.trials[0].answer).toBe(timeout ? null : 'violet');
          expect(artifact.trials[0].scores).toEqual(allFalse);
          expect(artifact.trials[0].errors).toEqual(
            timeout
              ? [{ kind: 'timeout' }, { kind: 'cleanup' }, { kind: 'cleanup' }]
              : [{ kind: 'cleanup' }, { kind: 'cleanup' }],
          );
          expect(artifact.errors).toEqual([
            { kind: 'cleanup' },
            { kind: 'cleanup' },
          ]);
          expect(artifact).not.toHaveProperty('comparison');
          expect(Agent.prototype.session).toHaveBeenCalledTimes(1);
          expect(owned.session.close).toHaveBeenCalledTimes(1);
          expect(owned.providerClose).toHaveBeenCalledTimes(1);
          expect(owned.events).toEqual([
            'session.close.begin',
            'session.close.end',
            'provider.close',
          ]);
          expect(JSON.stringify(artifact)).not.toContain(privateMessage);
        } finally {
          owned.answer.resolve({ finalOutput: 'violet' });
          owned.cleanup.resolve();
          await running;
        }
      },
    );
  },
);
