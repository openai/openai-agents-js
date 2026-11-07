import { z } from 'zod';
import { isHostedRegistration, type McpTool } from './mcp';
import { toolIdentity, type SessionTool, type ToolCatalog } from './tools';

const referenceSchema = z
  .object({
    name: z.string().min(1),
    namespace: z.string().min(1).default('functions'),
  })
  .strict();
export const checkpointToolReferencesSchema = z
  .array(referenceSchema)
  .superRefine((references, ctx) => {
    const keys = references.map((reference) =>
      JSON.stringify([reference.namespace, reference.name]),
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate checkpoint tool reference',
      });
  });
export type CheckpointToolReference = z.infer<typeof referenceSchema>;
export interface CheckpointSelections {
  readonly default_resource_servers?: readonly string[];
  readonly default_tools?: readonly CheckpointToolReference[];
  readonly operation_tools?: readonly CheckpointToolReference[];
}
const resourceServerNames = z
  .array(z.string().min(1))
  .refine(
    (names) => new Set(names).size === names.length,
    'Duplicate checkpoint resource server',
  );
export const checkpointSelectionFields = {
  default_resource_servers: resourceServerNames.optional(),
  default_tools: checkpointToolReferencesSchema.optional(),
  operation_tools: checkpointToolReferencesSchema.optional(),
};

/** @internal Apply the captured opening ceiling without granting new authority. */
export function assertAdmittedToolReference(
  reference: CheckpointToolReference,
  opening: unknown,
): void {
  if (
    Array.isArray(opening) &&
    !(
      reference.namespace === 'functions' && reference.name === 'tool_search'
    ) &&
    !opening.some(
      (allowed) =>
        allowed !== null &&
        typeof allowed === 'object' &&
        allowed.name === reference.name &&
        (allowed.namespace || 'functions') === reference.namespace,
    )
  )
    throw new TypeError(
      `Tool ${reference.name} was not admitted by this Session`,
    );
}

/** @internal Resolve managed defaults from current declarations, never saved bindings. */
export function checkpointDefaultTools(
  references: readonly CheckpointToolReference[] | undefined,
  catalog: ToolCatalog,
): readonly SessionTool[] {
  if (references === undefined) return catalog.tools;
  return Object.freeze(
    references.map((reference) => {
      const tool = catalog.tools.find((candidate) => {
        const identity = toolIdentity(candidate);
        return (
          identity.name === reference.name &&
          identity.namespace === reference.namespace
        );
      });
      if (!tool)
        throw new TypeError(
          'Checkpoint default tools require matching current declarations',
        );
      return tool;
    }),
  );
}

/** @internal Validate saved static identities before opening or publishing requests. */
export function assertCheckpointSelections(
  selections: CheckpointSelections,
  catalog: ToolCatalog,
  opening: unknown,
  pending: readonly { name: string; namespace?: string }[] = [],
): void {
  checkpointDefaultTools(selections.default_tools, catalog);
  const references = selections.operation_tools;
  if (references === undefined) return;
  for (const reference of references)
    assertAdmittedToolReference(reference, opening);
  if (
    pending.some(
      (call) =>
        !references.some(
          (reference) =>
            reference.name === call.name &&
            reference.namespace === (call.namespace ?? 'functions'),
        ),
    )
  )
    throw new TypeError(
      'Checkpoint selection does not admit its pending manual tools',
    );
}

/** @internal Resolve empty resource selections against current declarations only. */
export function checkpointResourceServers(
  names: readonly string[] | undefined,
  opening: readonly McpTool[],
): readonly McpTool[] {
  if (names === undefined) return opening;
  const resourceOnly = (server: McpTool) =>
    !server.tools.length && !isHostedRegistration(server);
  if (
    names.some(
      (name) =>
        !opening.some((server) => resourceOnly(server) && server.name === name),
    )
  )
    throw new TypeError(
      'Checkpoint resource servers require matching current ordinary declarations',
    );
  return Object.freeze(
    opening.filter(
      (server) => !resourceOnly(server) || names.includes(server.name),
    ),
  );
}
