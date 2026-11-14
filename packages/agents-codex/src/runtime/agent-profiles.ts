import { isDeepStrictEqual } from 'node:util';
import type { Agent } from './public-agent';
import {
  supportsInputErrorRecovery,
  managedApproval,
  captureTools,
  toolDeclarationIdentity,
  type ToolCatalog,
  protocolToolSpecs,
} from './tools';
import { HttpMCP, StdioMCP, mcpConfig, mcpPolicies, type McpTool } from './mcp';
import { splitToolDeclarations } from './tool-declarations';
import { prepareOutput, type PreparedOutput } from './output';
import { environmentConfig, type Environment } from './environment';
import { binding, encode, type JsonObject } from './binding';
import { modelOverrides } from './provider';

/** Immutable declarations and original identities for one native roster. */
export interface CapturedAgentProfile<Context, Output> {
  readonly id: string;
  readonly agent: Agent<Context, Output>;
  readonly declaration: Agent<Context, Output>;
  readonly handoffs: Readonly<Record<string, string>>;
  readonly handoffCallbacks?: Readonly<Record<string, number>>;
  readonly decisionHandoffs?: Readonly<
    Record<string, Readonly<{ slot: number; targets: readonly string[] }>>
  >;
  readonly handoffOptions?: Readonly<
    Record<string, import('./realtime-agent-config').RealtimeHandoff<Context>>
  >;
  readonly callbackTools?: readonly import('./tools').FunctionTool<Context>[];
  readonly hostedPromptControls?: JsonObject;
  readonly nativeProviderId?: string;
}

export interface AgentProfileRuntime {
  readonly profile: CapturedAgentProfile<any, any>;
  readonly catalog: ToolCatalog;
  readonly output: PreparedOutput;
  readonly instructions: string;
  readonly mcp: readonly McpTool[];
}
export interface CapturedAgentGraph {
  readonly rootId: string;
  /** @internal Captured resources are confined to their owning runtime. */
  readonly environments?: ReadonlyMap<
    string,
    import('./environment-source').EnvironmentAcquisition
  >;
  readonly deferred?: import('./deferred-agent-preparation').DeferredAgentPreparation;
  readonly workspace?: Pick<
    import('./sandbox-capabilities').SandboxCapabilityLease,
    'prepareWorkspace' | 'failWorkspace'
  >;
  /** Pure native preflight of this exact supplied history, before resource acquisition. */
  readonly restoredSource?: AgentProfileReceipt;
  /** Owning-turn declaration supplying an explicit suspended operation ceiling. */
  readonly operationSource?: AgentProfileReceipt;
  readonly profiles: ReadonlyMap<string, AgentProfileRuntime>;
  readonly usesProfileOutputGuidance: boolean;
  readonly roster: readonly JsonObject[];
}
export interface AgentProfileReceipt {
  readonly profile_id: string;
  readonly epoch: string;
}
const U64_MAX = 18446744073709551615n;

/** Decode only a private native profile receipt; its numbers are native u64 IDs.
 * Application argument/output JSON never passes through this decoder.
 */
export function parseProfileReceipt(source: string): unknown {
  const numbers = new WeakMap<object, Map<string, string>>();
  const parsed: unknown = JSON.parse(
    source,
    function (key, value: unknown, context?: { source?: string }) {
      if (typeof value === 'number' && context?.source !== undefined) {
        let fields = numbers.get(this);
        if (!fields) numbers.set(this, (fields = new Map()));
        fields.set(key, context.source);
      }
      return value;
    },
  );
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const restore = (value: unknown, key: string) => {
    const row = object(value);
    if (!row || typeof row[key] !== 'number') return;
    row[key] = profileInteger(numbers.get(row)?.get(key));
  };
  const row = object(parsed);
  if (row) {
    if (typeof row.profile_id === 'string') restore(row, 'epoch');
    restore(row.active, 'epoch');
    restore(row.profile_receipt, 'epoch');
    restore(row, 'catalog_generation');
    restore(row, 'generation_high_water');
    restore(row.active_catalog, 'generation');
    const catalogs = object(row.catalogs);
    if (catalogs)
      for (const key of Object.keys(catalogs)) restore(catalogs, key);
  }
  return parsed;
}
export function profileInteger(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > U64_MAX
  )
    throw new TypeError('Invalid native Agent receipt integer');
  return value;
}
export function checkProfileReceipt(
  value: unknown,
  graph: CapturedAgentGraph,
): AgentProfileReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    !('profile_id' in value) ||
    typeof value.profile_id !== 'string' ||
    !graph.profiles.has(value.profile_id) ||
    !('epoch' in value)
  )
    throw new TypeError('Native source has no admitted Agent profile');
  return Object.freeze({
    profile_id: value.profile_id,
    epoch: profileInteger(value.epoch),
  });
}
/** Portable history cannot grant a callback-backed profile transition. */
export function checkPortableProfileReceipt(
  value: unknown,
  graph: CapturedAgentGraph,
): AgentProfileReceipt {
  const receipt = checkProfileReceipt(value, graph);
  const candidates = [graph.rootId];
  const visited = new Set<string>();
  while (candidates.length) {
    const id = candidates.pop()!;
    if (id === receipt.profile_id) return receipt;
    if (visited.has(id)) continue;
    visited.add(id);
    const profile = graph.profiles.get(id)!.profile;
    for (const [name, target] of Object.entries(profile.handoffs))
      if (
        !profile.handoffCallbacks ||
        !Object.hasOwn(profile.handoffCallbacks, name)
      )
        candidates.push(target);
  }
  throw new TypeError(
    'Restored Agent profile requires live callback acceptance',
  );
}

export function encodeProfileReceipt(receipt: AgentProfileReceipt): string {
  return JSON.stringify({
    profile_id: receipt.profile_id,
    epoch: JSON.rawJSON(profileInteger(receipt.epoch)),
  });
}

/** Require current declared content or independent authority before hiding saved instructions. */
export async function assertRestoredInstructionContent<Context, Output>(
  history: readonly JsonObject[],
  profiles: readonly CapturedAgentProfile<Context, Output>[],
  rootInstructions: string,
): Promise<void> {
  const expected = new Map(
    profiles.map((profile, index) => [
      profile.id,
      index === 0 ? rootInstructions : (profile.declaration.instructions ?? ''),
    ]),
  );
  const native = await binding();
  const publications = new Map<string, JsonObject>();
  const projections: JsonObject[] = [];
  const unauthorized =
    'Restoring changed Agent instructions requires authenticated SessionState';
  for (const row of history) {
    if (row.type !== 'response_item') continue;
    const payload = row.payload as JsonObject | undefined;
    const metadata = row.metadata as JsonObject | undefined;
    const kinds = (
      payload?.internal_chat_message_metadata_passthrough as
        JsonObject | undefined
    )?.content_item_kinds;
    const hidden =
      payload?.role === 'developer' &&
      metadata?.client_authored !== true &&
      Array.isArray(kinds) &&
      kinds.length > 0 &&
      Array.isArray(payload.content) &&
      kinds.length === payload.content.length &&
      kinds.every(
        (kind) =>
          kind === 'sdk_application.accepted' ||
          kind === 'sdk_application.instructions',
      );
    if (hidden && kinds.includes('sdk_application.instructions'))
      projections.push(row);
    const receipt = metadata?.sdk_agent_profile as JsonObject | undefined;
    if (receipt == null) {
      if (hidden && kinds.includes('sdk_application.accepted'))
        throw new TypeError(unauthorized);
      continue;
    }
    const declared =
      typeof receipt.profile_id === 'string'
        ? expected.get(receipt.profile_id)
        : undefined;
    // Reuse the native receipt decoder, including its tag and revision checks.
    const saved = native._read_session_instructions(encode([row]));
    const revision = (row.payload as JsonObject | undefined)?.id;
    // Native SDK revisions use an opaque UUID. Other text in this model-visible
    // header requires the same explicit authority as changed instructions.
    const canonicalRevision =
      typeof revision === 'string' &&
      /^msg_sdk_application_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        revision,
      );
    if (declared === undefined || saved !== declared || !canonicalRevision)
      throw new TypeError(unauthorized);
    const content = payload!.content as JsonObject[];
    publications.set(content[0].text as string, row);
  }
  // A model-only projection needs its exact declaration-validated publication.
  // Index the rendered body, then let the native decoder validate the pair.
  for (const row of projections) {
    const content = (row.payload as JsonObject).content as JsonObject[];
    const owners = new Set<JsonObject>();
    for (const part of content) {
      const publication = publications.get(part.text as string);
      if (!publication) throw new TypeError(unauthorized);
      owners.add(publication);
    }
    native._read_session_instructions(encode([...owners, row]));
  }
}

/** Capture callbacks and schemas before opening resources; Core owns activation. */
export function captureProfileRuntimes(
  profiles: readonly CapturedAgentProfile<any, any>[],
  rootCatalog: ToolCatalog,
  rootInstructions: string,
  outputGuardrails = false,
  inputGuardrails = false,
  rootModelSettings = profiles[0]?.declaration.modelSettings,
): CapturedAgentGraph {
  if (!profiles.length)
    throw new TypeError('A native Agent graph requires its root');
  const captured = new Map<string, AgentProfileRuntime>();
  const usesHostedPrompts = profiles.some(
    (profile) => profile.hostedPromptControls !== undefined,
  );
  const outputs = profiles.map(({ declaration }) =>
    prepareOutput(declaration.outputType),
  );
  const usesProfileSchemas =
    outputs.some((output) => output.schema !== undefined) &&
    outputs.some(
      (output) => !isDeepStrictEqual(output.schema, outputs[0].schema),
    );
  const usesDistinctProfileOutputGuidance = outputs.some(
    (output) => output.prompt !== outputs[0].prompt,
  );
  const usesProfileOutputGuidance =
    outputs.some((output) => output.prompt !== undefined) &&
    (usesDistinctProfileOutputGuidance ||
      profiles.some(
        ({ declaration }) => declaration.prepareHandoffInput !== undefined,
      ));
  const roster: JsonObject[] = [];
  for (const [index, profile] of profiles.entries()) {
    const declaration = profile.declaration;
    const { tools, mcp } = splitToolDeclarations(declaration.tools);
    const callbackOwners = new Set(
      profile.callbackTools?.map(toolDeclarationIdentity) ?? [],
    );
    const catalog =
      index === 0
        ? profile.callbackTools?.length
          ? captureTools([
              ...rootCatalog.tools.filter(
                (tool) => !callbackOwners.has(toolDeclarationIdentity(tool)),
              ),
              ...profile.callbackTools,
            ])
          : rootCatalog
        : captureTools(tools);
    const output = outputs[index];
    const instructions =
      index === 0 ? rootInstructions : (declaration.instructions ?? '');
    const model = modelOverrides(
      declaration.model,
      declaration.modelSettings,
      usesHostedPrompts ? (profile.hostedPromptControls ?? null) : undefined,
    );
    const retryPolicy = (
      index === 0 ? rootModelSettings : declaration.modelSettings
    )?.retry?.policy;
    const controls = (model.request_controls ??= {}) as JsonObject;
    if (output.strict === false) controls.output_schema_strict = false;
    if (controls.retry !== null)
      controls.retry = {
        ...((controls.retry ?? {}) as JsonObject),
        has_policy: retryPolicy !== undefined,
      };
    const policies = JSON.parse(mcpPolicies(mcp, 0n));
    captured.set(
      profile.id,
      Object.freeze({
        profile,
        catalog,
        output,
        instructions,
        mcp: Object.freeze([...mcp]),
      }),
    );
    roster.push({
      id: profile.id,
      ...(profile.nativeProviderId === undefined
        ? {}
        : { native_provider_id: profile.nativeProviderId }),
      model: {
        model: model.model ?? '',
        reasoning_effort: model.effort ?? null,
        reasoning_summary: model.summary ?? null,
        service_tier: model.service_tier ?? null,
        tool_choice: model.tool_choice ?? null,
        invocation_timeout_ms: model.invocation_timeout_ms ?? null,
        request_controls: model.request_controls ?? {},
        personality: null,
      },
      instructions,
      tools: JSON.parse(catalog.specsJson),
      manual_slots: catalog.tools.flatMap((tool, slot) =>
        tool.kind === 'manual' ? [slot] : [],
      ),
      input_error_slots: catalog.tools.flatMap((tool, slot) =>
        supportsInputErrorRecovery(tool) ? [slot] : [],
      ),
      terminal_slots: catalog.tools.flatMap((tool, slot) =>
        (tool.kind !== 'manual' && tool.finishTurn) ||
        managedApproval(tool)?.function.finishTurn
          ? [slot]
          : [],
      ),
      step_defaults: catalog.tools.map((_, index) => index),
      handoffs: { ...profile.handoffs },
      ...(Object.keys(profile.decisionHandoffs ?? {}).length
        ? {
            decision_handoffs:
              profile.decisionHandoffs as unknown as JsonObject,
          }
        : {}),
      ...(Object.keys(profile.handoffCallbacks ?? {}).length
        ? { handoff_callbacks: { ...profile.handoffCallbacks } }
        : {}),
      transform_context:
        declaration.transformContext !== undefined ||
        declaration.hostedPrompt !== undefined,
      before_compact:
        declaration.beforeCompact !== undefined ||
        declaration.compaction !== undefined,
      ...(declaration.compaction !== undefined
        ? { post_turn_compact: true }
        : {}),
      tool_batch_completion: declaration.toolBatchCompletion !== undefined,
      before_complete:
        declaration.beforeComplete !== undefined ||
        declaration.outputGuardrails.length > 0 ||
        outputGuardrails ||
        declaration.inputGuardrails.length > 0 ||
        inputGuardrails,
      selecting_steps: declaration.inputGuardrails.some(
        (guard) => guard.childCallback !== undefined,
      ),
      output_fingerprint: output.identity.fingerprint,
      ...(usesProfileSchemas
        ? output.schema === undefined
          ? { wire_output_plain: true }
          : { wire_output_schema: output.schema }
        : {}),
      ...(usesProfileOutputGuidance && output.prompt !== undefined
        ? usesDistinctProfileOutputGuidance
          ? { wire_output_guidance: output.prompt }
          : { runtime_output_guidance: output.prompt }
        : {}),
      mcp_servers: Object.fromEntries(mcp.map((server) => [server.name, {}])),
      mcp_result_tools: policies.servers,
      mcp_metadata_tools: policies.metadata_servers,
      ...(policies.discovery_servers === undefined
        ? {}
        : { mcp_discovery_tools: policies.discovery_servers }),
      mcp_tools: Object.fromEntries(
        mcp.map((server) => [
          server.name,
          {
            tools: [...server.tools],
            defer_loading: server.deferLoading ?? false,
            before: !!server.before,
            approval: !!server.approval,
          },
        ]),
      ),
    });
  }
  return Object.freeze({
    rootId: profiles[0].id,
    profiles: captured,
    roster: Object.freeze(roster),
    usesProfileOutputGuidance,
  });
}

/** Complete live connection configuration after Environment acquisition. */
export function profileRoster(
  graph: CapturedAgentGraph,
  environment?: Environment,
): readonly JsonObject[] {
  return graph.roster.map((row) => ({
    ...row,
    ...(graph.environments &&
    !graph.deferred?.resources.deferred.has(row.id as string)
      ? {
          environment_tools: [
            ...(graph.environments.get(row.id as string)?.environment?.tools ??
              []),
          ],
          ...(graph.environments.get(row.id as string) !==
            graph.environments.get(graph.rootId) &&
          graph.environments.get(row.id as string)?.environment
            ? {
                environment: environmentConfig(
                  graph.environments.get(row.id as string)!.environment!,
                ),
              }
            : {}),
        }
      : {}),
    ...(graph.deferred?.resources.deferred.has(row.id as string)
      ? {
          environment_preparation: true,
          workspace_preparation: true,
          environment_tools: [],
          ...(graph.deferred.declaration(row.id as string)
            ? { prepared: graph.deferred.declaration(row.id as string)! }
            : {}),
        }
      : {}),
    mcp_servers: mcpConfig(
      graph.profiles
        .get(row.id as string)!
        .mcp.filter(
          (server) =>
            (server.tools.length > 0 ||
              (server instanceof StdioMCP && server.lifetime === 'turn')) &&
            (!(server instanceof HttpMCP) || server.activation !== 'operation'),
        ),
      graph.environments?.get(row.id as string)?.environment ?? environment,
      graph.profiles.get(row.id as string)!.profile.declaration
        .programmaticToolCalling,
      graph.profiles.get(row.id as string)!.mcp,
    ),
  }));
}

/** Validate the allocation receipt before publishing any corresponding host catalog. */
export function allocatedProfileCatalogs(
  graph: CapturedAgentGraph,
  raw: unknown,
  previousHighWater = 0n,
): {
  active: AgentProfileReceipt;
  highWater: bigint;
  profiles: ReadonlyMap<string, AgentProfileRuntime>;
  activeCatalog: ToolCatalog;
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('catalogs' in raw) ||
    !raw.catalogs ||
    typeof raw.catalogs !== 'object' ||
    Array.isArray(raw.catalogs) ||
    !('generation_high_water' in raw) ||
    !('active' in raw)
  )
    throw new TypeError('Invalid native Agent catalog receipt');
  const allocations = Object.entries(raw.catalogs);
  const highWater = BigInt(profileInteger(raw.generation_high_water));
  if (
    highWater < previousHighWater ||
    allocations.length !== graph.profiles.size
  )
    throw new TypeError('Invalid native Agent catalog high-water mark');
  const profiles = new Map<string, AgentProfileRuntime>();
  const seen = new Set<string>();
  for (const [id, rawGeneration] of allocations) {
    const runtime = graph.profiles.get(id);
    const generation = profileInteger(rawGeneration);
    if (!runtime || seen.has(generation) || BigInt(generation) > highWater)
      throw new TypeError('Invalid native Agent catalog allocation');
    seen.add(generation);
    profiles.set(
      id,
      Object.freeze({
        ...runtime,
        catalog: Object.freeze({
          ...runtime.catalog,
          generation: BigInt(generation),
        }),
      }),
    );
  }
  const active = checkProfileReceipt(raw.active, graph);
  const current = 'active_catalog' in raw ? raw.active_catalog : undefined;
  if (
    !current ||
    typeof current !== 'object' ||
    Array.isArray(current) ||
    !('generation' in current) ||
    !('specs' in current)
  )
    throw new TypeError('Native Agent receipt is missing its active catalog');
  const generation = profileInteger(current.generation);
  if (BigInt(generation) > highWater)
    throw new TypeError('Invalid native active Agent catalog generation');
  const template = profiles.get(active.profile_id)!.catalog;
  const activeCatalog = projectProfileCatalog(
    template,
    current.specs,
    BigInt(generation),
  );
  if (
    seen.has(generation) &&
    (generation !== template.generation.toString() ||
      !isDeepStrictEqual(
        JSON.parse(activeCatalog.specsJson),
        JSON.parse(template.specsJson),
      ))
  )
    throw new TypeError(
      'Native active Agent catalog conflicts with an immutable template',
    );
  return { active, highWater, profiles, activeCatalog };
}

/** Resolve fresh original declarations in the exact order proved by native restore. */
export function projectProfileCatalog(
  template: ToolCatalog,
  specs: unknown,
  generation = template.generation,
): ToolCatalog {
  if (!Array.isArray(specs))
    throw new TypeError('Invalid native active Agent tool layout');
  const available: unknown[] = protocolToolSpecs(template);
  const used = new Set<number>();
  const tools = specs.map((spec) => {
    const index = available.findIndex((candidate) =>
      isDeepStrictEqual(candidate, spec),
    );
    if (index < 0 || used.has(index))
      throw new TypeError(
        'Native active Agent catalog does not match fresh declarations',
      );
    used.add(index);
    return template.tools[index];
  });
  return captureTools(tools, generation);
}
