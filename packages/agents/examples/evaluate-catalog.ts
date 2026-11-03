import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Agent, tool, type NativeProvider } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

const catalog: Readonly<Record<string, string>> = { A: 'violet' };
export const catalogCases = [
  { id: 'known', code: 'A', expected: 'violet' },
  { id: 'absent', code: 'Z', expected: 'UNKNOWN' },
] as const;
const model = 'gpt-5.5';
const instructions =
  'Look up the requested code exactly once. Reply with its value only.';
const fingerprint = createHash('sha256')
  .update(JSON.stringify({ catalog, cases: catalogCases }))
  .digest('hex');
const trialSchema = z.strictObject({
  id: z.enum(['known', 'absent']),
  completed: z.boolean(),
  answer: z.string().nullable(),
  calls: z.array(z.strictObject({ code: z.string() })),
  failure: z.enum(['timeout', 'runtime']).nullable(),
});
export const catalogArtifactSchema = z
  .strictObject({
    format: z.literal(1),
    scorer: z.literal('exact-catalog-v1'),
    mode: z.literal('scripted'),
    model: z.string(),
    instructions: z.string(),
    fingerprint: z.literal(fingerprint),
    trials: z.array(trialSchema).length(2),
  })
  .superRefine((artifact, ctx) => {
    if (new Set(artifact.trials.map((trial) => trial.id)).size !== 2) {
      ctx.addIssue({
        code: 'custom',
        message: 'Require each fixed case exactly once.',
      });
    }
  });
export type CatalogTrial = z.infer<typeof trialSchema>;
export type CatalogArtifact = z.infer<typeof catalogArtifactSchema>;

export function scoreCatalogTrial(trial: CatalogTrial) {
  const testCase = catalogCases.find((item) => item.id === trial.id)!;
  const completion = trial.completed && trial.failure === null;
  const answer = trial.answer?.trim() === testCase.expected;
  const calls =
    trial.calls.length === 1 && trial.calls[0].code === testCase.code;
  return { completion, answer, calls, passed: completion && answer && calls };
}

/** The schema rejects other formats, modes, fingerprints and missing/duplicate IDs. */
export function compareCatalogBaseline(
  candidate: CatalogArtifact,
  input: unknown,
) {
  const baseline = catalogArtifactSchema.parse(input);
  const regressions = candidate.trials.flatMap((trial) => {
    const before = baseline.trials.find((item) => item.id === trial.id)!;
    return scoreCatalogTrial(before).passed && !scoreCatalogTrial(trial).passed
      ? [trial.id]
      : [];
  });
  const passed = (artifact: CatalogArtifact) =>
    artifact.trials.filter((trial) => scoreCatalogTrial(trial).passed).length;
  return { regressions, passedChange: passed(candidate) - passed(baseline) };
}

/** Catch only safe categories; never put raw errors or credentials in the artifact. */
export async function evaluateCatalogCase(
  provider: NativeProvider,
  testCase: (typeof catalogCases)[number],
  timeoutMs = 30_000,
): Promise<CatalogTrial> {
  const trial: CatalogTrial = {
    id: testCase.id,
    completed: false,
    answer: null,
    calls: [],
    failure: null,
  };
  let timedOut = false;
  try {
    const lookup = tool({
      name: 'lookup',
      parameters: z.strictObject({ code: z.string() }),
      execute: ({ code }) => {
        trial.calls.push({ code });
        return catalog[code] ?? 'UNKNOWN';
      },
    });
    const agent = new Agent({ instructions, model, provider, tools: [lookup] });
    await using session = await agent.session();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const turn = await session.submit(`Look up code ${testCase.code}.`);
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Catalog deadline exceeded.'));
        }, timeoutMs);
      });
      trial.answer = (await Promise.race([turn.wait(), deadline])).finalOutput;
      trial.completed = true;
    } finally {
      clearTimeout(timer);
      // Session disposal stops and joins work after a timed-out reader.
    }
  } catch {
    trial.completed = false;
    trial.failure = timedOut ? 'timeout' : 'runtime';
  }
  return trial;
}

/** Run both fixed cases once. Synthetic prompts, answers and calls appear in this file. */
export async function runCatalogEvaluation(
  outputPath: string,
  baselinePath?: string,
) {
  const baseline: unknown = baselinePath
    ? JSON.parse(await readFile(baselinePath, 'utf8'))
    : undefined;
  if (baselinePath) catalogArtifactSchema.parse(baseline);
  const trials: CatalogTrial[] = [];
  for (const testCase of catalogCases) {
    let trial: CatalogTrial | undefined;
    try {
      await withScriptedResponses(
        [
          [
            toolCall(
              'lookup',
              { code: testCase.code },
              { callId: testCase.id },
            ),
          ],
          [text(testCase.expected)],
        ],
        async (peer) => {
          trial = await evaluateCatalogCase(peer.provider, testCase);
          // Read the real callback output, independently of prescribed final text.
          if (
            trial.completed &&
            peer.toolOutput(testCase.id) !== testCase.expected
          ) {
            trial.completed = false;
            trial.failure = 'runtime';
          }
          peer.assertExhausted();
        },
      );
    } catch {
      trial = {
        id: testCase.id,
        completed: false,
        answer: trial?.answer ?? null,
        calls: trial?.calls ?? [],
        failure: trial?.failure ?? 'runtime',
      };
    }
    trials.push(trial!);
  }
  const artifact = catalogArtifactSchema.parse({
    format: 1,
    scorer: 'exact-catalog-v1',
    mode: 'scripted',
    model,
    instructions,
    fingerprint,
    trials,
  });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  const comparison = baselinePath
    ? compareCatalogBaseline(artifact, baseline)
    : null;
  return {
    artifact,
    comparison,
    passed: artifact.trials.filter((trial) => scoreCatalogTrial(trial).passed)
      .length,
  };
}

if (typeof require !== 'undefined' && require.main === module) {
  const [outputPath = 'catalog-evaluation.json', baselinePath, ...extra] =
    process.argv.slice(2);
  if (extra.length) {
    console.error('Usage: evaluate-catalog.ts [output.json] [baseline.json]');
    process.exitCode = 1;
  } else {
    runCatalogEvaluation(outputPath, baselinePath).then(
      (result) => {
        console.log(
          JSON.stringify({
            passed: result.passed,
            total: 2,
            comparison: result.comparison,
          }),
        );
        if (result.passed !== 2 || result.comparison?.regressions.length)
          process.exitCode = 1;
      },
      () => {
        console.error(
          'Catalog evaluation could not read its baseline or write its artifact.',
        );
        process.exitCode = 1;
      },
    );
  }
}
