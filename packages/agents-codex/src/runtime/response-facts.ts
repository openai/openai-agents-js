import { z } from 'zod';

const alternativeSchema = z
  .object({
    token: z.string(),
    bytes: z.array(z.number().int().min(0).max(255)).optional(),
    logprob: z.number().finite(),
  })
  .strict();
const tokenSchema = alternativeSchema.extend({
  topLogprobs: z.array(alternativeSchema).optional(),
});
const nullableIndex = z.number().int().nonnegative().safe().nullable();
export const responseFactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('refusal'),
      itemId: z.string().nullable(),
      contentIndex: nullableIndex,
      snapshot: z.boolean(),
      text: z.string(),
      captureComplete: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text_probabilities'),
      itemId: z.string().nullable(),
      outputIndex: nullableIndex,
      contentIndex: nullableIndex,
      snapshot: z.boolean(),
      delta: z.string().nullable(),
      tokens: z.array(tokenSchema),
      captureComplete: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('capture_truncated') }).strict(),
  z.object({ kind: z.literal('malformed_probabilities') }).strict(),
]);
export const responseFactRecordSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    requestId: z.string().nullable(),
    responseId: z.string().nullable(),
    upstreamRequestId: z.string().optional(),
    fact: responseFactSchema,
  })
  .strict();
export type ProbabilityAlternative = z.infer<typeof alternativeSchema>;
export type ProbabilityToken = z.infer<typeof tokenSchema>;
export type ResponseFact = z.infer<typeof responseFactSchema>;
/** Model-invisible received facts. Completion refers to capture, not response status. */
export type RecordedResponseFact = z.infer<typeof responseFactRecordSchema>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function alternative(value: unknown): unknown {
  const raw = object(value);
  return (
    raw && {
      token: raw.token,
      ...(raw.bytes == null ? {} : { bytes: raw.bytes }),
      logprob: raw.logprob,
    }
  );
}
function token(value: unknown): unknown {
  const raw = object(value);
  return (
    raw && {
      ...(alternative(raw) as object),
      ...(raw.top_logprobs == null
        ? {}
        : {
            topLogprobs: Array.isArray(raw.top_logprobs)
              ? raw.top_logprobs.map(alternative)
              : raw.top_logprobs,
          }),
    }
  );
}
/** @internal Select typed native fields; never forward an arbitrary event body. */
export function projectResponseFactRecord(
  value: unknown,
): RecordedResponseFact | null {
  const raw = object(value),
    source = object(raw?.fact);
  if (!raw || !source) return null;
  let fact: unknown;
  switch (source.kind) {
    case 'refusal':
      fact = {
        kind: source.kind,
        itemId: source.item_id,
        contentIndex: source.content_index,
        snapshot: source.snapshot,
        text: source.text,
        captureComplete: source.capture_complete,
      };
      break;
    case 'text_probabilities':
      fact = {
        kind: source.kind,
        itemId: source.item_id,
        outputIndex: source.output_index,
        contentIndex: source.content_index,
        snapshot: source.snapshot,
        delta: source.delta,
        tokens: Array.isArray(source.tokens)
          ? source.tokens.map(token)
          : source.tokens,
        captureComplete: source.capture_complete,
      };
      break;
    case 'capture_truncated':
    case 'malformed_probabilities':
      fact = { kind: source.kind };
      break;
    default:
      return null;
  }
  const parsed = responseFactRecordSchema.safeParse({
    id: raw.id,
    threadId: raw.thread_id,
    turnId: raw.turn_id,
    requestId: raw.request_id ?? null,
    responseId: raw.response_id ?? null,
    ...(typeof raw.upstream_request_id === 'string'
      ? { upstreamRequestId: raw.upstream_request_id }
      : {}),
    fact,
  });
  return parsed.success ? parsed.data : null;
}

export type ResponseFactSummary =
  | Exclude<ResponseFact, { kind: 'refusal' | 'text_probabilities' }>
  | { kind: 'refusal' | 'text_probabilities'; captureComplete: boolean };
export type RecordedResponseFactSummary = Omit<RecordedResponseFact, 'fact'> & {
  fact: ResponseFactSummary;
};
/** @internal Existing trusted-detail observation policy, with no new capture switch. */
export function summarizeResponseFactRecord(
  record: RecordedResponseFact | RecordedResponseFactSummary,
): RecordedResponseFactSummary {
  const fact = record.fact;
  return structuredClone({
    ...record,
    fact:
      fact.kind === 'refusal' || fact.kind === 'text_probabilities'
        ? { kind: fact.kind, captureComplete: fact.captureComplete }
        : fact,
  });
}
