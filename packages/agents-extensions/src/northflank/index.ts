import type { ApiClient } from '@northflank/js-client';

import { buildDeployTools } from './tools/deploy';
import { buildExecTools } from './tools/exec';
import { buildFileTools } from './tools/files';
import { buildLogsTools } from './tools/logs';
import { buildMetricsTools } from './tools/metrics';
import { buildReadTools } from './tools/read';
import { buildSecretsTools } from './tools/secrets';
import type {
  NorthflankTool,
  NorthflankToolGroup,
  NorthflankToolsOptions,
} from './types';

export type {
  NorthflankApprovalsConfig,
  NorthflankTool,
  NorthflankToolGroup,
  NorthflankToolName,
  NorthflankToolsOptions,
} from './types';

export { NorthflankShell } from './shell';
export type { NorthflankShellOptions, NorthflankShellTarget } from './shell';

const DEFAULT_INCLUDE: NorthflankToolGroup[] = [
  'read',
  'deploy',
  'exec',
  'files',
  'logs',
  'metrics',
];

/**
 * Build a curated array of OpenAI Agents `FunctionTool`s that talk to a
 * Northflank `ApiClient`. By default 16 tools across six groups (the
 * `secrets` group is opt-in via `include`).
 *
 * Pair this with `NorthflankShell` and `shellTool({ shell })` to also give
 * the agent a hosted-shell into a Northflank container, or with
 * `NorthflankSandboxClient` (from `@openai/agents-extensions/sandbox/northflank`)
 * to back a full `SandboxAgent`.
 *
 * @example
 * ```ts
 * import { ApiClient, ApiClientInMemoryContextProvider } from '@northflank/js-client';
 * import { Agent, run } from '@openai/agents';
 * import { northflankTools } from '@openai/agents-extensions/northflank';
 *
 * const ctx = new ApiClientInMemoryContextProvider();
 * await ctx.addContext({ name: 'default', token: process.env.NF_API_TOKEN! });
 * const client = new ApiClient(ctx, { throwErrorOnHttpErrorCode: true });
 *
 * const agent = new Agent({
 *   name: 'Northflank Operator',
 *   tools: northflankTools(client, { defaultProjectId: 'my-project' }),
 * });
 *
 * const result = await run(agent, 'Restart the api service.');
 * ```
 */
export function northflankTools(
  client: ApiClient,
  options: NorthflankToolsOptions = {},
): NorthflankTool[] {
  const include = new Set<NorthflankToolGroup>(
    options.include ?? DEFAULT_INCLUDE,
  );

  const tools: NorthflankTool[] = [];
  if (include.has('read')) tools.push(...buildReadTools(client, options));
  if (include.has('deploy')) tools.push(...buildDeployTools(client, options));
  if (include.has('exec')) tools.push(...buildExecTools(client, options));
  if (include.has('files')) tools.push(...buildFileTools(client, options));
  if (include.has('logs')) tools.push(...buildLogsTools(client, options));
  if (include.has('metrics')) tools.push(...buildMetricsTools(client, options));
  if (include.has('secrets')) tools.push(...buildSecretsTools(client, options));

  return tools;
}
