import { isDeepStrictEqual } from 'node:util';
import {
  losslessJsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from './binding';
import type { ToolRef } from './tools';

const declaration = Symbol('nativeHostedMcp');

/** Live provider configuration stays outside the portable tool declaration. */
export class HostedMcpBinding {
  readonly serverLabel: string;
  #configuration: JsonObject;

  constructor(configuration: unknown) {
    this.#configuration = losslessJsonObjectSchema.parse(
      JSON.parse(JSON.stringify(configuration)),
    );
    const label = this.#configuration.server_label;
    if (typeof label !== 'string' || !label.trim())
      throw new TypeError('Hosted MCP requires a nonempty serverLabel');
    this.serverLabel = label;
  }

  configuration(): JsonObject {
    return losslessJsonObjectSchema.parse(this.#configuration);
  }

  admitsTool(name: string): boolean {
    const allowed = this.#configuration.allowed_tools;
    const names = Array.isArray(allowed)
      ? allowed
      : allowed && typeof allowed === 'object'
        ? allowed.tool_names
        : undefined;
    return !Array.isArray(names) || names.includes(name);
  }

  get requiresApproval(): boolean {
    return this.#configuration.require_approval !== 'never';
  }

  admitsCaller(caller: JsonValue | undefined): boolean {
    const allowed = this.#configuration.allowed_callers;
    const kind =
      caller == null
        ? 'direct'
        : caller && typeof caller === 'object' && !Array.isArray(caller)
          ? caller.type
          : undefined;
    return (
      (kind === 'direct' || kind === 'code_interpreter') &&
      (Array.isArray(allowed) ? allowed.includes(kind) : kind === 'direct')
    );
  }
}

export function hostedMcpBinding(tool: unknown): HostedMcpBinding | undefined {
  return tool && typeof tool === 'object'
    ? (tool as { [declaration]?: HostedMcpBinding })[declaration]
    : undefined;
}

export function bindHostedMcp<T extends object>(
  tool: T,
  binding: HostedMcpBinding,
): T & { readonly ref: ToolRef } {
  return Object.freeze({
    ...tool,
    [declaration]: binding,
    ref: Object.freeze({
      kind: 'tool_ref' as const,
      name: binding.serverLabel,
      namespace: 'hosted_mcp',
    }),
  });
}

export function hostedMcpConfigurations(
  tools: readonly unknown[],
): JsonObject[] {
  const configurations = new Map<string, JsonObject>();
  for (const tool of tools) {
    const binding = hostedMcpBinding(tool);
    if (!binding) continue;
    const configuration = binding.configuration();
    const previous = configurations.get(binding.serverLabel);
    if (previous && !isDeepStrictEqual(previous, configuration))
      throw new TypeError('Conflicting Hosted MCP server configuration');
    configurations.set(binding.serverLabel, configuration);
  }
  return [...configurations.values()];
}

/** Selection and callback replacement never replace the Session's provider authority. */
export function assertHostedMcpConfigurations(
  tools: readonly unknown[],
  opening: readonly JsonObject[],
): void {
  for (const configuration of hostedMcpConfigurations(tools)) {
    const original = opening.find(
      (value) =>
        value.type === 'mcp' &&
        value.server_label === configuration.server_label,
    );
    if (!isDeepStrictEqual(original, configuration))
      throw new TypeError(
        'Hosted MCP server configuration is fixed for this Session; open a new Session to change it',
      );
  }
}
