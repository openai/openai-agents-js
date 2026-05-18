import type { ApiClient } from '@northflank/js-client';
import { tool } from '@openai/agents-core';
import { z } from 'zod';

import type { NorthflankTool, NorthflankToolsOptions } from '../types';
import {
  buildParams,
  DEFAULT_OUTPUT_LIMIT,
  nu,
  resolveNeedsApproval,
  resolveProjectId,
  runApiCall,
  truncate,
} from '../util';

/**
 * Recent runtime-log fetch for a service. We surface a flat string so the
 * model can scan it as if it were terminal output, with each line prefixed by
 * the container ID and timestamp.
 */
export function buildLogsTools(
  client: ApiClient,
  options: NorthflankToolsOptions,
): NorthflankTool[] {
  const limit = options.outputCharLimit ?? DEFAULT_OUTPUT_LIMIT;
  const projectIdSchema = options.defaultProjectId
    ? z
        .string()
        .nullable()
        .optional()
        .describe(
          'Northflank project ID. Defaults to the configured project — pass null to use the default.',
        )
    : z.string().describe('Northflank project ID.');

  const getServiceLogs = tool({
    name: 'northflank_get_service_logs',
    description:
      'Fetch recent runtime logs for a Northflank service. Returns a chronological line-oriented stream. Use `durationSeconds` to look back N seconds (default 300 = 5 minutes).',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Service ID.'),
      durationSeconds: z
        .number()
        .int()
        .min(1)
        .max(86_400)
        .nullable()
        .optional()
        .describe('Lookback window. Pass null for 5 minutes (300s).'),
      containerName: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Filter to a specific container, or "all". Pass null for default.',
        ),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_get_service_logs',
      options.approvals,
    ),
    execute: async ({
      projectId,
      serviceId,
      durationSeconds,
      containerName,
    }) => {
      const now = new Date();
      const start = new Date(
        now.getTime() - (nu(durationSeconds) ?? 300) * 1000,
      );
      const cName = nu(containerName);
      const result = await runApiCall(() =>
        client.get.service.logs({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options), serviceId },
            options,
          ),
          options: {
            startTime: start,
            endTime: now,
            ...(cName ? { containerName: cName } : {}),
          } as any,
        } as any),
      );
      if (!result.ok) return `Error fetching logs: ${result.error}`;
      const lines = (result.value ?? [])
        .map((line: any) => {
          const ts =
            line.ts instanceof Date
              ? line.ts.toISOString()
              : String(line.ts ?? '');
          const log =
            typeof line.log === 'string' ? line.log : JSON.stringify(line.log);
          return `[${ts}] ${line.containerId ?? ''} ${log}`;
        })
        .join('\n');
      return truncate(lines || '(no log entries in window)', limit);
    },
  });

  return [getServiceLogs];
}
