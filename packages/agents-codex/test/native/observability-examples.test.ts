import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  httpError,
  text,
  toolCall,
  withScriptedResponses,
} from '@openai/agents/testing';
import {
  catalogArtifactSchema,
  catalogCases,
  compareCatalogBaseline,
  evaluateCatalogCase,
  scoreCatalogTrial,
  type CatalogTrial,
} from '../../../../examples/codex/evaluate-catalog';
import { startTraceReceiver } from '../../../../examples/codex/native-telemetry';

const trial: CatalogTrial = {
  id: 'known',
  completed: true,
  answer: 'violet',
  calls: [{ code: 'A' }],
  failure: null,
};
function artifact(
  trials = [
    trial,
    {
      ...trial,
      id: 'absent' as const,
      answer: 'UNKNOWN',
      calls: [{ code: 'Z' }],
    },
  ],
) {
  // Read the fixed fingerprint from the schema, not a second copy of its inputs.
  const fingerprint = catalogArtifactSchema.shape.fingerprint.value;
  return catalogArtifactSchema.parse({
    format: 1,
    scorer: 'exact-catalog-v1',
    mode: 'scripted',
    model: 'synthetic-model',
    instructions: 'synthetic instructions',
    fingerprint,
    trials,
  });
}

describe('small catalog checks without native execution', () => {
  it('scores completion, exact trimmed answer and actual ordered calls separately', () => {
    expect(scoreCatalogTrial({ ...trial, answer: ' violet\n' }).passed).toBe(
      true,
    );
    expect(scoreCatalogTrial({ ...trial, answer: 'Violet' }).answer).toBe(
      false,
    );
    expect(scoreCatalogTrial({ ...trial, completed: false }).completion).toBe(
      false,
    );
    expect(
      scoreCatalogTrial({ ...trial, calls: [{ code: 'A' }, { code: 'A' }] })
        .calls,
    ).toBe(false);
    expect(
      scoreCatalogTrial({ ...trial, calls: [{ code: 'Z' }, { code: 'A' }] })
        .calls,
    ).toBe(false);
  });
  it('rejects incompatible modes, scorers, fingerprints and missing/duplicate cases', () => {
    const good = artifact();
    for (const changed of [
      { mode: 'live' },
      { scorer: 'new' },
      { fingerprint: 'other' },
      { trials: [trial] },
      { trials: [trial, trial] },
    ]) {
      expect(() =>
        compareCatalogBaseline(good, { ...good, ...changed }),
      ).toThrow();
    }
    expect(
      compareCatalogBaseline(
        { ...good, model: 'candidate', instructions: 'changed' },
        good,
      ),
    ).toEqual({ regressions: [], passedChange: 0 });
    const failed = artifact([{ ...trial, answer: 'wrong' }, good.trials[1]]);
    expect(compareCatalogBaseline(failed, good)).toEqual({
      regressions: ['known'],
      passedChange: -1,
    });
  });
  it('keeps failure artifacts small and rejects arbitrary error fields', () => {
    const failed = artifact([
      { ...trial, completed: false, answer: null, failure: 'runtime' },
      artifact().trials[1],
    ]);
    expect(scoreCatalogTrial(failed.trials[0]).passed).toBe(false);
    expect(() =>
      catalogArtifactSchema.parse({ ...failed, error: 'private stack' }),
    ).toThrow();
  });
});

describe('bounded local trace receiver without native execution', () => {
  it('accepts JSON only at the fixed POST path and rejects malformed/oversized bodies', async () => {
    await using receiver = await startTraceReceiver();
    expect((await fetch(receiver.endpoint)).status).toBe(404);
    expect(
      (
        await fetch(`${receiver.endpoint}/other`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(receiver.endpoint, { method: 'POST', body: '{' })).status,
    ).toBe(400);
    expect(
      (
        await fetch(receiver.endpoint, {
          method: 'POST',
          body: 'x'.repeat(1_048_577),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await fetch(receiver.endpoint, {
          method: 'POST',
          body: '{"resourceSpans":[]}',
        })
      ).status,
    ).toBe(200);
    expect(receiver.batches).toEqual([{ resourceSpans: [] }]);
  });
});

function command(file: string, args: string[] = [], failRequests = false) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      ...(failRequests
        ? ['--import', resolve(__dirname, 'fixtures/catalog-failure.mjs')]
        : []),
      resolve(__dirname, '../../../../examples/codex', file),
      ...args,
    ],
    {
      cwd: resolve(__dirname, '../../../..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native observability examples',
  () => {
    it('runs telemetry in a fresh process and receives real trace identities', async () => {
      const result = await command('native-telemetry.ts');
      expect(result, result.stderr).toMatchObject({ code: 0 });
      const summary = JSON.parse(result.stdout.trim());
      expect(summary.batches).toBeGreaterThan(0);
      expect(
        summary.spans.some((span: { traceId?: string }) => span.traceId),
      ).toBe(true);
      expect(
        summary.receipts.map((receipt: { outcome: string }) => receipt.outcome),
      ).toEqual(['completed', 'completed', 'failed', 'failed']);
      expect(
        summary.receipts.every(
          (receipt: { history: unknown[] }) => receipt.history.length > 0,
        ),
      ).toBe(true);
    }, 50_000);
    it('writes an artifact, compares a baseline, and exits after closing all owners', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'catalog-evaluation-'));
      try {
        const path = join(directory, 'candidate.json');
        expect(await command('evaluate-catalog.ts', [path])).toMatchObject({
          code: 0,
        });
        const saved = catalogArtifactSchema.parse(
          JSON.parse(await readFile(path, 'utf8')),
        );
        expect(
          saved.trials.map(scoreCatalogTrial).every((score) => score.passed),
        ).toBe(true);
        expect(
          await command('evaluate-catalog.ts', [
            join(directory, 'second.json'),
            path,
          ]),
        ).toMatchObject({ code: 0 });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 100_000);
    it('writes safe failure artifacts and exits unsuccessfully when model requests fail', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'catalog-failure-'));
      try {
        const path = join(directory, 'failed.json');
        const result = await command('evaluate-catalog.ts', [path], true);
        expect(result.code, result.stderr).toBe(1);
        const saved = catalogArtifactSchema.parse(
          JSON.parse(await readFile(path, 'utf8')),
        );
        expect(
          saved.trials.every(
            (trial) => trial.failure === 'runtime' && !trial.completed,
          ),
        ).toBe(true);
        expect(JSON.stringify(saved)).not.toContain('synthetic-private-error');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 50_000);
    it('joins the owned native Session after its reader times out', async () => {
      const stopped = new Error('Expected timeout test exit.');
      await expect(
        withScriptedResponses([[text('violet')]], async (peer) => {
          const observed = await evaluateCatalogCase(
            peer.provider,
            catalogCases[0],
            0,
          );
          expect(observed).toMatchObject({
            completed: false,
            failure: 'timeout',
          });
          // Deliberately unfinished script: leave through an error so its cleanup runs
          // without claiming successful script exhaustion.
          throw stopped;
        }),
      ).rejects.toBe(stopped);
    }, 50_000);
    it('records actual tool requests and distinguishes wrong answers from runtime failures', async () => {
      await withScriptedResponses(
        [
          [toolCall('lookup', { code: 'A' }, { callId: 'receipt' })],
          [text('wrong')],
        ],
        async (peer) => {
          const observed = await evaluateCatalogCase(
            peer.provider,
            catalogCases[0],
          );
          expect(observed.calls).toEqual([{ code: 'A' }]);
          expect(peer.toolOutput('receipt')).toBe('violet');
          expect(JSON.stringify(peer.requests)).toContain('Look up code A.');
          expect(scoreCatalogTrial(observed)).toMatchObject({
            completion: true,
            answer: false,
            calls: true,
          });
          peer.assertExhausted();
        },
      );
      await withScriptedResponses(
        [httpError(400, { error: { message: 'synthetic-private-error' } })],
        async (peer) => {
          const observed = await evaluateCatalogCase(
            peer.provider,
            catalogCases[0],
          );
          expect(observed.failure).toBe('runtime');
          expect(JSON.stringify(observed)).not.toContain(
            'synthetic-private-error',
          );
          peer.assertExhausted();
        },
      );
    }, 50_000);
  },
);
