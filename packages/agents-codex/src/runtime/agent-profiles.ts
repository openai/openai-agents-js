import { isDeepStrictEqual } from 'node:util';
import type { Agent } from './public-agent';
import { captureTools, type ToolCatalog } from './tools';
import {
  splitToolDeclarations,
  HttpMCP,
  StdioMCP,
  mcpConfig,
  mcpPolicies,
  type McpTool,
} from './mcp';
import { prepareOutput, type PreparedOutput } from './output';
import type { Environment } from './environment';
import type { JsonObject } from './binding';
import { modelOverrides } from './provider';

/** Immutable declarations and original identities for one native roster. */
export interface CapturedAgentProfile<Context, Output> {
  readonly id: string;
  readonly agent: Agent<Context, Output>;
  readonly declaration: Agent<Context, Output>;
  readonly handoffs: Readonly<Record<string, string>>;
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
  /** Pure native preflight of this exact supplied history, before resource acquisition. */
  readonly restoredSource?: AgentProfileReceipt;
  /** Owning-turn declaration supplying an explicit suspended operation ceiling. */
  readonly operationSource?: AgentProfileReceipt;
  readonly profiles: ReadonlyMap<string, AgentProfileRuntime>;
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
export function encodeProfileReceipt(receipt: AgentProfileReceipt): string {
  return JSON.stringify({
    profile_id: receipt.profile_id,
    epoch: JSON.rawJSON(profileInteger(receipt.epoch)),
  });
}

/** Capture callbacks and schemas before opening resources; Core owns activation. */
export function captureProfileRuntimes(
  profiles: readonly CapturedAgentProfile<any, any>[],
  rootCatalog: ToolCatalog,
  rootInstructions: string,
): CapturedAgentGraph {
  if (!profiles.length)
    throw new TypeError('A native Agent graph requires its root');
  const captured = new Map<string, AgentProfileRuntime>();
  const roster: JsonObject[] = [];
  for (const [index, profile] of profiles.entries()) {
    const declaration = profile.declaration;
    const { tools, mcp } = splitToolDeclarations(declaration.tools);
    const catalog = index === 0 ? rootCatalog : captureTools(tools);
    const output = prepareOutput(declaration.outputType);
    const instructions =
      index === 0 ? rootInstructions : declaration.instructions;
    const model = modelOverrides(declaration.model, declaration.modelSettings);
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
      terminal_slots: catalog.tools.flatMap((tool, slot) =>
        tool.kind !== 'manual' && tool.finishTurn ? [slot] : [],
      ),
      step_defaults: catalog.tools.map((_, index) => index),
      handoffs: { ...profile.handoffs },
      transform_context: declaration.transformContext !== undefined,
      before_compact: declaration.beforeCompact !== undefined,
      before_complete: declaration.beforeComplete !== undefined,
      selecting_steps: false,
      output_fingerprint: output.identity.fingerprint,
      mcp_servers: Object.fromEntries(mcp.map((server) => [server.name, {}])),
      mcp_result_tools: policies.servers,
      mcp_metadata_tools: policies.metadata_servers,
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
  });
}

/** Complete live connection configuration after Environment acquisition. */
export function profileRoster(
  graph: CapturedAgentGraph,
  environment?: Environment,
): readonly JsonObject[] {
  return graph.roster.map((row) => ({
    ...row,
    mcp_servers: mcpConfig(
      graph.profiles
        .get(row.id as string)!
        .mcp.filter(
          (server) =>
            (server.tools.length > 0 ||
              (server instanceof StdioMCP && server.lifetime === 'turn')) &&
            (!(server instanceof HttpMCP) || server.activation !== 'operation'),
        ),
      environment,
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
  const available: unknown[] = JSON.parse(template.specsJson);
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
