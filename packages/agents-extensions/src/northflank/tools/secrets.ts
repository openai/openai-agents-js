import type { ApiClient } from '@northflank/js-client';
import { tool } from '@openai/agents-core';
import { z } from 'zod';

import type { NorthflankTool, NorthflankToolsOptions } from '../types';
import {
  buildParams,
  jsonResult,
  nu,
  resolveNeedsApproval,
  resolveProjectId,
  runApiCall,
} from '../util';

/**
 * Secrets group. Opt-in (not enabled in the default `include`) because even
 * listing secret metadata can leak naming patterns.
 */
export function buildSecretsTools(
  client: ApiClient,
  options: NorthflankToolsOptions,
): NorthflankTool[] {
  const projectIdSchema = options.defaultProjectId
    ? z
        .string()
        .nullable()
        .optional()
        .describe(
          'Northflank project ID. Defaults to the configured project — pass null to use the default.',
        )
    : z.string().describe('Northflank project ID.');

  const listSecrets = tool({
    name: 'northflank_list_secrets',
    description:
      'List secret groups in a Northflank project. Returns secret group names and metadata only — never the secret values themselves.',
    parameters: z.object({
      projectId: projectIdSchema,
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_list_secrets',
      options.approvals,
    ),
    execute: async ({ projectId }) => {
      const result = await runApiCall(() =>
        client.list.secrets({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options) },
            options,
          ),
        } as any),
      );
      if (!result.ok) return `Error listing secrets: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  return [listSecrets];
}
