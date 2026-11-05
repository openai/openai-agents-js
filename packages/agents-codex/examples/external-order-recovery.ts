import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  manualTool,
  parseSessionState,
  type NativeProvider,
  type Session,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';

const orderSchema = z.strictObject({
  tenant: z.string().min(1),
  orderId: z.string().min(1),
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
});
export type AuthorizedOrder = z.infer<typeof orderSchema>;
export const syntheticOrder: AuthorizedOrder = {
  tenant: 'sample-tenant',
  orderId: 'order-42',
  sku: 'violet',
  quantity: 1,
};
const argumentsSchema = z.strictObject({ orderId: z.string().min(1) });
const publicResultSchema = z.strictObject({
  orderId: z.string(),
  status: z.literal('fulfilled'),
});
const bindingSchema = z.strictObject({
  key: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const fulfillOrder = manualTool({
  name: 'fulfill_order',
  description: 'Ask the application to fulfill its authorized order.',
  parameters: argumentsSchema,
  result: publicResultSchema,
});
const instructions =
  'Call fulfill_order once for the application-selected order, then report its result.';
const base = {
  version: z.literal(1),
  binding: bindingSchema,
  checkpoint: z.string().min(1),
};
const receipt = {
  result: publicResultSchema,
  providerReceipt: z.string().min(1),
};
const journalSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...base, phase: z.literal('pending') }),
  z.strictObject({ ...base, phase: z.literal('creating') }),
  z.strictObject({ ...base, phase: z.literal('unknown') }),
  z.strictObject({ ...base, ...receipt, phase: z.literal('ready') }),
  z.strictObject({
    ...base,
    ...receipt,
    phase: z.literal('done'),
    finalOutput: z.string(),
  }),
]);
export type JobJournal = z.infer<typeof journalSchema>;
const effectSchema = z.strictObject({
  version: z.literal(1),
  binding: bindingSchema,
  ...receipt,
});
type Effect = z.infer<typeof effectSchema>;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function binding(order: AuthorizedOrder) {
  const authorized = orderSchema.parse(order);
  return {
    // Business identity survives changing native Session and call IDs.
    key: hash([authorized.tenant, authorized.orderId, 'fulfill']),
    digest: hash([authorized.sku, authorized.quantity]),
  };
}
function checkBinding(
  actual: z.infer<typeof bindingSchema>,
  order: AuthorizedOrder,
) {
  const expected = binding(order);
  if (actual.key !== expected.key || actual.digest !== expected.digest)
    throw new Error('The authorized order binding changed.');
}

/** Trusted local directory, one sequential owner. Atomic replacement is not a power-loss guarantee. */
export async function writeJobJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure: { error: unknown } | undefined;
  try {
    {
      await using file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    }
    await rename(temporary, path);
  } catch (error) {
    failure = { error };
  }
  try {
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (failure)
        throw new AggregateError(
          [failure.error, error],
          'Write and cleanup failed.',
        );
      throw error;
    }
  }
  if (failure) throw failure.error;
}
async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Parse only application-trusted storage; validation does not authenticate a checkpoint. */
export function parseJobJournal(
  value: unknown,
  order: AuthorizedOrder,
): JobJournal {
  const journal = journalSchema.parse(value);
  checkBinding(journal.binding, order);
  const state = parseSessionState(journal.checkpoint);
  if (state.format_version !== 3 && state.format_version !== 5)
    throw new Error('Expected the original pending manual checkpoint.');
  const pending = state.manual_continuation.pending_manual;
  if (
    pending.length !== 1 ||
    pending[0].name !== fulfillOrder.name ||
    pending[0].namespace !== undefined ||
    Object.keys(state.manual_continuation.accepted_replies).length !== 0 ||
    argumentsSchema.parse(JSON.parse(pending[0].arguments)).orderId !==
      order.orderId
  )
    throw new Error(
      'Checkpoint does not contain the authorized pending order.',
    );
  if ('result' in journal && journal.result.orderId !== order.orderId)
    throw new Error('Conflicting public result.');
  return journal;
}
export async function readJob(directory: string, order: AuthorizedOrder) {
  const value = await readJson(join(directory, 'job.json'));
  return value === undefined ? undefined : parseJobJournal(value, order);
}
async function saveJob(
  directory: string,
  journal: JobJournal,
  order: AuthorizedOrder,
) {
  await writeJobJson(
    join(directory, 'job.json'),
    parseJobJournal(journal, order),
  );
}
function agent(provider: NativeProvider) {
  return new Agent({ instructions, tools: [fulfillOrder], provider });
}
async function nextOrder(session: Session) {
  for await (const event of session.events()) {
    const request = fulfillOrder.match(event);
    if (request) return request;
    if (event.type === 'action_requested')
      throw new Error('Unexpected manual tool.');
    if (event.type === 'turn_finished') {
      await session.wait();
      throw new Error('The run completed without requesting the order.');
    }
  }
  throw new Error('Session closed before requesting the order.');
}

/** Save the supported manual boundary before any external dispatch. */
export async function prepareJob(
  directory: string,
  order: AuthorizedOrder,
  provider: NativeProvider,
) {
  if (await readJob(directory, order)) throw new Error('A job already exists.');
  await mkdir(directory, { recursive: true });
  const authorized = orderSchema.parse(order);
  await using session = await agent(provider).session();
  await session.submit(`Fulfill order ${authorized.orderId}.`);
  const request = await nextOrder(session);
  if (request.arguments.orderId !== authorized.orderId)
    throw new Error('Unauthorized order.');
  const journal: JobJournal = {
    version: 1,
    phase: 'pending',
    binding: binding(authorized),
    checkpoint: JSON.stringify(await session.suspend()),
  };
  await saveJob(directory, journal, authorized);
  return journal;
}

/** Authoritative local simulator lookup. A real provider may instead return an inconclusive outcome. */
export async function findSyntheticEffect(
  providerDirectory: string,
  order: AuthorizedOrder,
): Promise<Effect | undefined> {
  const value = await readJson(
    join(providerDirectory, `${binding(order).key}.json`),
  );
  if (value === undefined) return undefined;
  const effect = effectSchema.parse(value);
  checkBinding(effect.binding, order);
  if (effect.result.orderId !== order.orderId)
    throw new Error('Conflicting provider result.');
  return effect;
}

/** The single persisted record IS the synthetic effect and its receipt. No real order is placed. */
export async function createSyntheticEffect(
  providerDirectory: string,
  order: AuthorizedOrder,
): Promise<Effect> {
  const existing = await findSyntheticEffect(providerDirectory, order);
  if (existing) return existing;
  await mkdir(providerDirectory, { recursive: true });
  const effect: Effect = {
    version: 1,
    binding: binding(order),
    providerReceipt: randomUUID(),
    result: { orderId: order.orderId, status: 'fulfilled' },
  };
  await writeJobJson(
    join(providerDirectory, `${effect.binding.key}.json`),
    effect,
  );
  return effect;
}

/** Reconcile creating before dispatch. 'unknown' requires an application/operator decision. */
export async function reconcileJob(
  directory: string,
  providerDirectory: string,
  order: AuthorizedOrder,
  lookup: typeof findSyntheticEffect = findSyntheticEffect,
): Promise<JobJournal> {
  let journal = await readJob(directory, order);
  if (!journal) throw new Error('Prepare the job first.');
  if (journal.phase === 'unknown')
    throw new Error('Provider outcome is unknown; automatic dispatch refused.');
  if (journal.phase === 'ready' || journal.phase === 'done') return journal;
  journal = { ...journal, phase: 'creating' };
  await saveJob(directory, journal, order);
  let found: Effect | undefined;
  try {
    found = await lookup(providerDirectory, order);
  } catch (error) {
    try {
      await saveJob(directory, { ...journal, phase: 'unknown' }, order);
    } catch (saveError) {
      throw new AggregateError(
        [error, saveError],
        'Lookup and unknown-state persistence failed.',
      );
    }
    throw error;
  }
  // Authoritative absence permits same-key create-or-find in this simulator.
  const effect =
    found ?? (await createSyntheticEffect(providerDirectory, order));
  checkBinding(effect.binding, order);
  const ready: JobJournal = {
    ...journal,
    phase: 'ready',
    result: effect.result,
    providerReceipt: effect.providerReceipt,
  };
  await saveJob(directory, ready, order);
  return ready;
}

/** Answer only the newly issued live grant; never persist request.reply or reconstruct it from a call ID. */
export async function answerJob(
  directory: string,
  order: AuthorizedOrder,
  provider: NativeProvider,
): Promise<string> {
  const journal = await readJob(directory, order);
  if (!journal || (journal.phase !== 'ready' && journal.phase !== 'done'))
    throw new Error('No durable public result.');
  if (journal.phase === 'done') return journal.finalOutput;
  let answered = false;
  const result = await agent(provider).run(null, {
    state: parseSessionState(journal.checkpoint),
    onInteraction(event) {
      const request = fulfillOrder.match(event);
      if (answered || !request || request.arguments.orderId !== order.orderId)
        throw new Error('Unexpected or duplicate order request.');
      answered = true;
      return request.reply(journal.result);
    },
  });
  if (!answered)
    throw new Error('Restoration did not issue the pending order.');
  return result.finalOutput;
}

/** Call only after answerJob settles successfully. Keep the original checkpoint in the terminal receipt. */
export async function settleJob(
  directory: string,
  order: AuthorizedOrder,
  finalOutput: string,
) {
  const journal = await readJob(directory, order);
  if (!journal || journal.phase !== 'ready')
    throw new Error('Expected a ready job.');
  await saveJob(directory, { ...journal, phase: 'done', finalOutput }, order);
}

async function main() {
  const directory = process.argv[2];
  if (!directory)
    throw new Error(
      'Pass an application-selected trusted local directory. Use one sequential owner.',
    );
  const providerDirectory = join(directory, 'synthetic-provider');
  const existing = await readJob(directory, syntheticOrder);
  if (existing?.phase === 'done') {
    console.log(existing.finalOutput);
    return;
  }
  // This scripted demo requires the built native addon, but no model credentials.
  await withScriptedResponses(
    [
      ...(!existing
        ? [
            [
              toolCall(
                'fulfill_order',
                { orderId: syntheticOrder.orderId },
                { callId: 'order-call' },
              ),
            ],
          ]
        : []),
      [text('The synthetic order is fulfilled.')],
    ],
    async (peer) => {
      if (!existing) await prepareJob(directory, syntheticOrder, peer.provider);
      await reconcileJob(directory, providerDirectory, syntheticOrder);
      const output = await answerJob(directory, syntheticOrder, peer.provider);
      await settleJob(directory, syntheticOrder, output);
      console.log(output);
    },
  );
}
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
