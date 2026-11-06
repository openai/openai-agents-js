import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  Agent,
  NativeError,
  NativeProvider,
  tool,
  type Session,
} from '@openai/agents';
import {
  text,
  toolCall,
  withScriptedResponses,
  type ScriptedResponse,
} from '@openai/agents/testing';
import { z } from 'zod';
import {
  artifactSchema,
  assertCompatibleBaseline,
  CATALOG,
  catalogValue,
  casesSchema,
  compareArtifacts,
  configurationSchema,
  hashJson,
  parseBaseline,
  SCORER_IDENTITY,
  scoreTrial,
  type Artifact,
  type Case,
  type Configuration,
  type Failure,
  type LookupEffect,
  type Mode,
} from './scoring';

class WaitTimedOut extends Error {}

type Progress = {
  answer: string | null;
  effects: LookupEffect[];
  errors: Failure[];
  cleanupFailed: boolean;
};

function recordFailure(progress: Progress, error: unknown): void {
  progress.errors.push({
    kind:
      error instanceof WaitTimedOut
        ? 'timeout'
        : error instanceof NativeError
          ? 'native'
          : 'execution',
  });
}

function recordCleanupFailure(progress: Progress): void {
  progress.errors.push({ kind: 'cleanup' });
  progress.cleanupFailed = true;
}

async function runSession(
  provider: NativeProvider,
  config: Configuration,
  testCase: Case,
  progress: Progress,
): Promise<void> {
  let session: Session<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = tool({
      name: 'lookup',
      description: 'Look up one code in the synthetic catalog.',
      parameters: z.object({ code: z.string() }),
      execute({ code }) {
        try {
          const output = catalogValue(code);
          progress.effects.push({ code, output });
          return output;
        } catch {
          progress.errors.push({ kind: 'tool' });
          throw new Error('Synthetic catalog lookup failed');
        }
      },
    });
    session = await new Agent({
      instructions: config.instructions,
      model: config.model,
      modelSettings: { reasoningEffort: config.reasoningEffort },
      provider,
      tools: [lookup],
    }).session();
    const turn = await session.submit(testCase.prompt);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WaitTimedOut()), config.timeoutMs);
    });
    // The reader deadline does not cancel native work. Closing owns that step.
    progress.answer = (await Promise.race([turn.wait(), deadline])).finalOutput;
  } catch (error) {
    recordFailure(progress, error);
  } finally {
    clearTimeout(timer);
    try {
      await session?.close();
    } catch {
      recordCleanupFailure(progress);
    }
  }
}

async function runScripted(
  config: Configuration,
  testCase: Case,
  progress: Progress,
): Promise<void> {
  const calls = testCase.expectedLookups.map((code) => ({
    code,
    callId: randomUUID(),
  }));
  const responses: ScriptedResponse[] = [];
  if (calls.length) {
    responses.push(
      calls.map(({ code, callId }) => toolCall('lookup', { code }, { callId })),
    );
  }
  responses.push([text(testCase.expectedAnswer)]);
  // Throwing this sentinel makes the helper close its scope without demanding
  // consumption of responses that a failed or cancelled trial could not read.
  const failedTrial = new Error('Evaluation trial failed');
  let entered = false;
  try {
    await withScriptedResponses(responses, async (peer) => {
      entered = true;
      await runSession(peer.provider, config, testCase, progress);
      if (progress.errors.length === 0) {
        try {
          peer.assertExhausted();
          if (
            peer.requests.length !== responses.length ||
            calls.some(
              ({ code, callId }) =>
                peer.toolOutput(callId) !== catalogValue(code),
            )
          ) {
            progress.errors.push({ kind: 'receipt' });
          }
        } catch {
          progress.errors.push({ kind: 'receipt' });
        }
      }
      if (progress.errors.length) throw failedTrial;
    });
  } catch (error) {
    if (error === failedTrial) return; // The helper joined its cleanup.
    if (entered || error instanceof AggregateError) {
      recordCleanupFailure(progress);
    } else {
      recordFailure(progress, error);
    }
  }
}

async function runLive(
  config: Configuration,
  testCase: Case,
  apiKey: string,
  progress: Progress,
): Promise<void> {
  let provider: NativeProvider | undefined;
  try {
    provider = new NativeProvider({ apiKey });
    await runSession(provider, config, testCase, progress);
  } catch (error) {
    recordFailure(progress, error);
  } finally {
    try {
      await provider?.close();
    } catch {
      recordCleanupFailure(progress);
    }
  }
}

async function sourceIdentity(): Promise<{
  source: Artifact['source'];
  sdkVersion: string;
}> {
  const root = resolve(__dirname, '../../..');
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const revision = git(['rev-parse', 'HEAD']);
  const dirty =
    git(['status', '--porcelain', '--untracked-files=normal']) !== '';
  const source = await Promise.all(
    ['run.ts', 'scoring.ts'].map((name) =>
      readFile(resolve(__dirname, name), 'utf8'),
    ),
  );
  const manifest = JSON.parse(
    await readFile(
      resolve(__dirname, '../../../packages/agents-codex/package.json'),
      'utf8',
    ),
  ) as { version: string };
  return {
    source: { revision, dirty, exampleSha256: hashJson(source) },
    sdkVersion: manifest.version,
  };
}

export type EvaluationOptions = {
  config: Configuration;
  cases: readonly Case[];
  mode?: Mode;
  repeats?: number;
  baseline?: unknown;
};

/** Run synthetic cases in order, retaining failed trials and joined cleanup. */
export async function evaluate(options: EvaluationOptions): Promise<Artifact> {
  const config = configurationSchema.parse(options.config);
  const cases = casesSchema.parse(options.cases);
  const mode = z.enum(['scripted', 'live']).parse(options.mode ?? 'scripted');
  const repeats = z
    .number()
    .int()
    .positive()
    .parse(options.repeats ?? 1);
  const baseline =
    options.baseline === undefined
      ? undefined
      : parseBaseline(options.baseline);
  if (baseline) assertCompatibleBaseline({ mode, cases, repeats }, baseline);
  // Capture the key before the first await, and never put it in the artifact.
  const apiKey = mode === 'live' ? process.env.OPENAI_API_KEY : undefined;
  if (mode === 'live' && !apiKey?.trim()) {
    throw new Error('Live mode requires OPENAI_API_KEY');
  }
  const identity = await sourceIdentity();
  const artifact: Artifact = {
    formatVersion: 1,
    scorerIdentity: SCORER_IDENTITY,
    mode,
    evidence: mode === 'scripted' ? 'harness_only' : 'live_model_trials',
    createdAt: new Date().toISOString(),
    ...identity,
    nodeVersion: process.versions.node,
    config,
    configSha256: hashJson(config),
    cases,
    casesSha256: hashJson(cases),
    catalog: { ...CATALOG },
    catalogSha256: hashJson(CATALOG),
    repeats,
    trials: [],
    aborted: false,
    errors: [],
  };
  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const started = performance.now();
      const progress: Progress = {
        answer: null,
        effects: [],
        errors: [],
        cleanupFailed: false,
      };
      if (mode === 'scripted') await runScripted(config, testCase, progress);
      else await runLive(config, testCase, apiKey!, progress);
      const scores = scoreTrial(
        progress.answer,
        progress.effects,
        testCase,
        progress.errors,
      );
      artifact.trials.push({
        caseId: testCase.id,
        repeat,
        answer: progress.answer,
        effects: progress.effects,
        errors: progress.errors,
        elapsedMs: performance.now() - started,
        scores,
        passed: Object.values(scores).every(Boolean),
      });
      if (progress.cleanupFailed) {
        artifact.aborted = true;
        artifact.errors.push(
          ...progress.errors.filter((error) => error.kind === 'cleanup'),
        );
        break;
      }
    }
    if (artifact.aborted) break;
  }
  if (baseline && !artifact.aborted) {
    artifact.comparison = compareArtifacts(artifact, baseline);
  }
  return artifactSchema.parse(artifact);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: 'string', default: 'scripted' },
      repeats: { type: 'string', default: '1' },
      output: { type: 'string' },
      baseline: { type: 'string' },
      config: { type: 'string', default: resolve(__dirname, 'config.json') },
      cases: { type: 'string', default: resolve(__dirname, 'cases.json') },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values.output) throw new Error('An --output path is required');
  const config = configurationSchema.parse(
    JSON.parse(await readFile(values.config, 'utf8')),
  );
  const cases = casesSchema.parse(
    JSON.parse(await readFile(values.cases, 'utf8')),
  );
  const baseline = values.baseline
    ? JSON.parse(await readFile(values.baseline, 'utf8'))
    : undefined;
  const artifact = await evaluate({
    config,
    cases,
    mode: z.enum(['scripted', 'live']).parse(values.mode),
    repeats: Number(values.repeats),
    baseline,
  });
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, JSON.stringify(artifact, null, 2) + '\n');
  console.log(
    JSON.stringify({
      evidence: artifact.evidence,
      trials: artifact.trials.length,
      passed: artifact.trials.filter((trial) => trial.passed).length,
      aborted: artifact.aborted,
      comparison: artifact.comparison,
    }),
  );
  return artifact.aborted || artifact.trials.some((trial) => !trial.passed)
    ? 1
    : 0;
}

// Source examples run as CommonJS under this checkout's tsx configuration.
if (typeof require !== 'undefined' && require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error(
        'Evaluation failed. Check input files, baseline compatibility, output access and live credentials.',
      );
      process.exitCode = 1;
    },
  );
}
