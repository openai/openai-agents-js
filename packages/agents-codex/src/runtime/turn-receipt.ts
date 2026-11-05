import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const instructionFile = z.object({
  path: z.string().min(1),
  source: z.enum([
    'application_file',
    'native_user',
    'native_thread',
    'native_project',
    'project_guidance',
  ]),
  sha256: hash,
});
export type InstructionFileReceipt = z.infer<typeof instructionFile>;

const executorNetwork = z
  .object({
    requires_proxy: z.boolean(),
    domains: z.record(z.string(), z.enum(['allow', 'deny'])).nullable(),
    allow_all_unix_sockets: z.boolean(),
    allow_local_binding: z.boolean().nullable(),
  })
  .transform((policy) => ({
    requiresProxy: policy.requires_proxy,
    domains: policy.domains,
    allowAllUnixSockets: policy.allow_all_unix_sockets,
    allowLocalBinding: policy.allow_local_binding,
  }));
export type ExecutorNetworkReceipt = z.output<typeof executorNetwork>;

const executorPolicy = z
  .object({
    environment_id: z.string(),
    transport: z.enum(['local', 'remote']),
    cwd: z.string(),
    writable_roots: z.array(z.string()),
    network_sandbox: z.enum(['restricted', 'enabled']),
    network_policy: executorNetwork.nullable(),
  })
  .transform((policy) => ({
    environmentId: policy.environment_id,
    transport: policy.transport,
    cwd: policy.cwd,
    writableRoots: policy.writable_roots,
    networkSandbox: policy.network_sandbox,
    networkPolicy: policy.network_policy,
  }));
export type ExecutorPolicyReceipt = z.output<typeof executorPolicy>;

const approvalPolicy = z.union([
  z.enum(['never', 'on-request', 'untrusted']),
  z.object({
    granular: z.object({
      sandbox_approval: z.boolean(),
      rules: z.boolean(),
      skill_approval: z.boolean(),
      request_permissions: z.boolean(),
      mcp_elicitations: z.boolean(),
    }),
  }),
]);

const turnReceipt = z.object({
  version: z.literal(1),
  thread_id: z.string().min(1),
  model: z.string(),
  reasoning_effort: z.string().nullable(),
  instruction_revision: z.string().nullable(),
  developer_instructions_sha256: hash.nullable(),
  instruction_files: z.array(instructionFile),
  user_config_applied: z.boolean(),
  codex_revision: gitSha,
  codex_source_tree: gitSha,
  approval_policy: approvalPolicy,
  executors: z.array(executorPolicy).nullable(),
});

/** Settings captured for the latest recorded sampling attempt in a native turn. */
export interface TurnReceipt {
  threadId: string;
  turnId: string;
  model: string;
  reasoningEffort: string | null;
  instructionRevision: string | null;
  developerInstructionsSha256: string | null;
  instructionFiles: InstructionFileReceipt[];
  userConfigApplied: boolean;
  codexRevision: string;
  codexSourceTree: string;
  approvalPolicy: z.infer<typeof approvalPolicy>;
  /** Portable snapshots withhold executor policy details. */
  executors: ExecutorPolicyReceipt[] | null;
}

/** SDK-owned repair observations can be copied to portable checkpoints. */
export const repairTurnReceiptSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    model: z.string(),
    reasoningEffort: z.string().nullable(),
    instructionRevision: z.string().nullable(),
    developerInstructionsSha256: hash.nullable(),
    instructionFiles: z.array(instructionFile),
    userConfigApplied: z.boolean(),
    codexRevision: gitSha,
    codexSourceTree: gitSha,
    approvalPolicy,
    executors: z.tuple([]).nullable(),
  })
  .strict() satisfies z.ZodType<TurnReceipt>;

export function projectTurnReceipt(
  value: unknown,
  turnId: string,
): TurnReceipt | undefined {
  const receipt = turnReceipt.safeParse(value);
  if (!receipt.success) return;
  const data = receipt.data;
  return {
    threadId: data.thread_id,
    turnId,
    model: data.model,
    reasoningEffort: data.reasoning_effort,
    instructionRevision: data.instruction_revision,
    developerInstructionsSha256: data.developer_instructions_sha256,
    instructionFiles: data.instruction_files,
    userConfigApplied: data.user_config_applied,
    codexRevision: data.codex_revision,
    codexSourceTree: data.codex_source_tree,
    approvalPolicy: data.approval_policy,
    executors: data.executors,
  };
}

export async function loadInstructionFiles(
  instructions: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<{ instructions: string; files: InstructionFileReceipt[] }> {
  const supplied = z.array(z.string().min(1)).parse(paths);
  const parts = instructions ? [instructions] : [];
  const files: InstructionFileReceipt[] = [];
  for (const name of supplied) {
    signal?.throwIfAborted();
    const path = await realpath(name);
    signal?.throwIfAborted();
    const expected = await lstat(path, { bigint: true });
    signal?.throwIfAborted();
    if (!expected.isFile())
      throw new TypeError(`Instruction file must be a regular file: ${path}`);
    // Preserve application-selected symlinks, but do not follow a substituted
    // link at the resolved leaf on hosts that support O_NOFOLLOW.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    let bytes: Buffer;
    try {
      signal?.throwIfAborted();
      const actual = await file.stat({ bigint: true });
      if (!actual.isFile())
        throw new TypeError(`Instruction file must be a regular file: ${path}`);
      if (actual.dev !== expected.dev || actual.ino !== expected.ino)
        throw new TypeError(`Instruction file changed while opening: ${path}`);
      bytes = await file.readFile({ signal });
    } catch (error) {
      const primary: unknown = signal?.aborted ? signal.reason : error;
      try {
        await file.close();
      } catch (closeError) {
        throw new AggregateError(
          [primary, closeError],
          'Reading and closing the instruction file failed',
          { cause: primary },
        );
      }
      throw primary;
    }
    await file.close();
    signal?.throwIfAborted();
    try {
      parts.push(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      );
    } catch {
      throw new TypeError(`Instruction file must be UTF-8: ${path}`);
    }
    files.push({
      path,
      source: 'application_file',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return { instructions: parts.join('\n\n'), files };
}
