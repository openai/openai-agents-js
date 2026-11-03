import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CATALOG: Readonly<Record<string, string>> = Object.freeze({
  A: 'violet',
  B: 'amber',
});
export const SCORER_IDENTITY = 'catalog-exact-v1';

const modeSchema = z.enum(['scripted', 'live']);
export type Mode = z.infer<typeof modeSchema>;

export const configurationSchema = z
  .object({
    model: z.string().trim().min(1),
    instructions: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
    // Bounds the reader after submit, not opening, admission, or cleanup.
    timeoutMs: z.number().int().positive().max(2_147_483_647).default(60_000),
  })
  .strict();
export type Configuration = z.infer<typeof configurationSchema>;

export const caseSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    expectedAnswer: z.string(),
    expectedLookups: z.array(z.string()),
  })
  .strict();
export type Case = z.infer<typeof caseSchema>;
export const casesSchema = z
  .array(caseSchema)
  .min(1)
  .refine(
    (cases) => new Set(cases.map((item) => item.id)).size === cases.length,
    {
      message: 'Cases must have unique IDs',
    },
  );

const effectSchema = z
  .object({ code: z.string(), output: z.string() })
  .strict();
export type LookupEffect = z.infer<typeof effectSchema>;

// Record lesson-owned failure kinds, never provider messages or error names.
export const failureSchema = z
  .object({
    kind: z.enum([
      'timeout',
      'native',
      'tool',
      'receipt',
      'cleanup',
      'execution',
    ]),
  })
  .strict();
export type Failure = z.infer<typeof failureSchema>;

const scoresSchema = z
  .object({
    completed: z.boolean(),
    answerExact: z.boolean(),
    toolBehavior: z.boolean(),
  })
  .strict();
export type Scores = z.infer<typeof scoresSchema>;
const scoreNames = ['completed', 'answerExact', 'toolBehavior'] as const;

export function catalogValue(code: string): string {
  return Object.hasOwn(CATALOG, code) ? CATALOG[code] : 'UNKNOWN';
}

/** Compare settled answers and actual effects; order and multiplicity matter. */
export function scoreTrial(
  answer: string | null,
  effects: readonly LookupEffect[],
  testCase: Case,
  errors: readonly Failure[],
): Scores {
  const completed = errors.length === 0 && answer !== null;
  return {
    completed,
    answerExact:
      completed &&
      answer !== null &&
      answer.trim() === testCase.expectedAnswer.trim(),
    toolBehavior:
      completed &&
      effects.length === testCase.expectedLookups.length &&
      effects.every(
        (effect, index) =>
          effect.code === testCase.expectedLookups[index] &&
          effect.output === catalogValue(effect.code),
      ),
  };
}

const trialSchema = z
  .object({
    caseId: z.string().min(1),
    repeat: z.number().int().positive(),
    answer: z.string().nullable(),
    effects: z.array(effectSchema),
    errors: z.array(failureSchema),
    elapsedMs: z.number().nonnegative(),
    scores: scoresSchema,
    passed: z.boolean(),
  })
  .strict();
export type Trial = z.infer<typeof trialSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    dirty: z.boolean(),
    exampleSha256: sha256Schema,
  })
  .strict();
export type SourceIdentity = z.infer<typeof sourceSchema>;

const comparisonSchema = z
  .object({
    baselineConfigSha256: sha256Schema,
    baselineSource: sourceSchema,
    regressions: z.array(
      z
        .object({
          caseId: z.string(),
          repeat: z.number().int().positive(),
          score: z.enum(scoreNames),
        })
        .strict(),
    ),
    passedTrialDelta: z.number().int(),
  })
  .strict();
export type Comparison = z.infer<typeof comparisonSchema>;

/** Hash parsed JSON with sorted object keys and unchanged array order. */
export function hashJson(value: unknown): string {
  function canonical(item: unknown): string {
    if (item === null || typeof item !== 'object') {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new TypeError('Expected a JSON value');
      return encoded;
    }
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.entries(item)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export const artifactSchema = z
  .object({
    formatVersion: z.literal(1),
    scorerIdentity: z.literal(SCORER_IDENTITY),
    mode: modeSchema,
    evidence: z.enum(['harness_only', 'live_model_trials']),
    createdAt: z.iso.datetime(),
    source: sourceSchema,
    sdkVersion: z.string().min(1),
    nodeVersion: z.string().min(1),
    config: configurationSchema,
    configSha256: sha256Schema,
    cases: casesSchema,
    casesSha256: sha256Schema,
    catalog: z.record(z.string(), z.string()),
    catalogSha256: sha256Schema,
    repeats: z.number().int().positive(),
    trials: z.array(trialSchema),
    aborted: z.boolean(),
    errors: z.array(failureSchema),
    comparison: comparisonSchema.optional(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: 'custom', message });
    if (
      artifact.evidence !==
      (artifact.mode === 'scripted' ? 'harness_only' : 'live_model_trials')
    )
      fail('Evidence does not match mode');
    if (artifact.configSha256 !== hashJson(artifact.config))
      fail('Configuration hash differs');
    if (artifact.casesSha256 !== hashJson(artifact.cases))
      fail('Cases hash differs');
    if (artifact.catalogSha256 !== hashJson(artifact.catalog))
      fail('Catalog hash differs');
    if (hashJson(artifact.catalog) !== hashJson(CATALOG))
      fail('Catalog differs from scorer catalog');
    const cases = new Map(artifact.cases.map((item) => [item.id, item]));
    const identities = new Set<string>();
    for (const trial of artifact.trials) {
      const key = JSON.stringify([trial.caseId, trial.repeat]);
      if (identities.has(key)) fail('Duplicate trial identity');
      identities.add(key);
      const testCase = cases.get(trial.caseId);
      if (!testCase || trial.repeat > artifact.repeats) {
        fail('Unexpected trial identity');
        continue;
      }
      const expected = scoreTrial(
        trial.answer,
        trial.effects,
        testCase,
        trial.errors,
      );
      if (scoreNames.some((name) => expected[name] !== trial.scores[name]))
        fail('Trial scores differ from observed outcome');
      if (trial.passed !== scoreNames.every((name) => trial.scores[name]))
        fail('Trial passed flag differs from scores');
    }
    if (
      !artifact.aborted &&
      artifact.trials.length !== artifact.cases.length * artifact.repeats
    )
      fail('Missing trial identities');
    if (artifact.aborted && artifact.errors.length === 0)
      fail('Aborted artifact requires an error');
    if (artifact.aborted && artifact.comparison)
      fail('Aborted artifact cannot contain a comparison');
  });
export type Artifact = z.infer<typeof artifactSchema>;

/** A baseline may contain failed trials, but must contain every trial. */
export function parseBaseline(value: unknown): Artifact {
  const baseline = artifactSchema.parse(value);
  if (baseline.aborted) throw new Error('Baseline was aborted');
  return baseline;
}

/** Check compatibility before acquiring a provider or executing any trial. */
export function assertCompatibleBaseline(
  current: { mode: Mode; cases: readonly Case[]; repeats: number },
  baseline: Artifact,
): void {
  const parsed = parseBaseline(baseline);
  if (current.mode !== parsed.mode) throw new Error('Baseline mode differs');
  if (hashJson(current.cases) !== parsed.casesSha256)
    throw new Error('Baseline cases differ');
  if (current.repeats !== parsed.repeats)
    throw new Error('Baseline repeats differ');
}

export function compareArtifacts(
  current: Artifact,
  baseline: Artifact,
): Comparison {
  const parsed = artifactSchema.parse(current);
  if (parsed.aborted) throw new Error('Current evaluation was aborted');
  assertCompatibleBaseline(parsed, baseline);
  const prior = new Map(
    baseline.trials.map((trial) => [
      JSON.stringify([trial.caseId, trial.repeat]),
      trial,
    ]),
  );
  const regressions: Comparison['regressions'] = [];
  for (const trial of parsed.trials) {
    const old = prior.get(JSON.stringify([trial.caseId, trial.repeat]))!;
    for (const score of scoreNames) {
      if (old.scores[score] && !trial.scores[score])
        regressions.push({ caseId: trial.caseId, repeat: trial.repeat, score });
    }
  }
  return {
    baselineConfigSha256: baseline.configSha256,
    baselineSource: baseline.source,
    regressions,
    passedTrialDelta:
      parsed.trials.filter((trial) => trial.passed).length -
      baseline.trials.filter((trial) => trial.passed).length,
  };
}
