import { UserError } from '../errors';
import type * as ProviderData from '../types/providerData';

type HostedMcpRequireApproval = Exclude<
  ProviderData.HostedMCPTool['require_approval'],
  undefined
>;

type ToolNamesFilter = { tool_names: string[] };

const REQUIRE_APPROVAL_POLICY_KEYS = new Set(['always', 'never']);
const TOOL_NAMES_KEYS = new Set(['toolNames', 'tool_names']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequireApproval(message: string): UserError {
  return new UserError(`Invalid hosted MCP requireApproval: ${message}`);
}

function normalizeToolNamesFilter(
  value: unknown,
  path: string,
): ToolNamesFilter {
  if (!isRecord(value)) {
    throw invalidRequireApproval(`${path} must be an object with toolNames.`);
  }

  const keys = Object.keys(value);
  const unknownKeys = keys.filter((key) => !TOOL_NAMES_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw invalidRequireApproval(
      `${path} has unsupported key "${unknownKeys[0]}".`,
    );
  }

  if ('toolNames' in value && 'tool_names' in value) {
    throw invalidRequireApproval(
      `${path} must not specify both toolNames and tool_names.`,
    );
  }

  const toolNames = value.toolNames ?? value.tool_names;
  if (!Array.isArray(toolNames)) {
    throw invalidRequireApproval(`${path}.toolNames must be an array.`);
  }

  for (const toolName of toolNames) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw invalidRequireApproval(
        `${path}.toolNames must contain only non-empty strings.`,
      );
    }
  }

  return { tool_names: [...toolNames] };
}

function findOverlappingToolName(
  always?: ToolNamesFilter,
  never?: ToolNamesFilter,
): string | undefined {
  if (!always || !never) {
    return undefined;
  }

  const neverNames = new Set(never.tool_names);
  return always.tool_names.find((toolName) => neverNames.has(toolName));
}

/**
 * Validates and canonicalizes hosted MCP approval policy config.
 */
export function normalizeHostedMcpRequireApproval(
  requireApproval: unknown,
): HostedMcpRequireApproval {
  if (typeof requireApproval === 'undefined') {
    return 'never';
  }

  if (typeof requireApproval === 'string') {
    if (requireApproval === 'always' || requireApproval === 'never') {
      return requireApproval;
    }
    throw invalidRequireApproval(
      `string value must be "always" or "never", got "${requireApproval}".`,
    );
  }

  if (!isRecord(requireApproval)) {
    throw invalidRequireApproval(
      'value must be "always", "never", or an object with always/never filters.',
    );
  }

  const keys = Object.keys(requireApproval);
  if (keys.length === 0) {
    throw invalidRequireApproval(
      'object value must include at least one of always or never.',
    );
  }

  const unknownKeys = keys.filter(
    (key) => !REQUIRE_APPROVAL_POLICY_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw invalidRequireApproval(
      `object value has unsupported key "${unknownKeys[0]}".`,
    );
  }

  const normalized: Exclude<HostedMcpRequireApproval, 'always' | 'never'> = {};
  if (typeof requireApproval.always !== 'undefined') {
    normalized.always = normalizeToolNamesFilter(
      requireApproval.always,
      'always',
    );
  }
  if (typeof requireApproval.never !== 'undefined') {
    normalized.never = normalizeToolNamesFilter(requireApproval.never, 'never');
  }

  const overlap = findOverlappingToolName(normalized.always, normalized.never);
  if (overlap) {
    throw invalidRequireApproval(
      `tool "${overlap}" cannot be listed in both always and never.`,
    );
  }

  return normalized;
}
