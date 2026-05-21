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

const METRIC_TYPES = [
  'cpu',
  'memory',
  'networkIngress',
  'networkEgress',
  'tcpConnectionsOpen',
  'diskUsage',
  'requests',
  'http4xxResponses',
  'http5xxResponses',
  'bandwidth',
  'bandwidthVolume',
] as const;

export function buildMetricsTools(
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

  const getServiceMetrics = tool({
    name: 'northflank_get_service_metrics',
    description:
      'Fetch a metrics range for a Northflank service. Returns time-series values for each requested metric over the lookback window.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Service ID.'),
      durationSeconds: z
        .number()
        .int()
        .min(60)
        .max(86_400)
        .nullable()
        .optional()
        .describe('Lookback window. Pass null for 15 minutes (900s).'),
      metricTypes: z
        .array(z.enum(METRIC_TYPES))
        .nullable()
        .optional()
        .describe('Metrics to include. Pass null for ["cpu", "memory"].'),
      containerName: z
        .string()
        .nullable()
        .optional()
        .describe('Container filter (or "all"). Pass null for default.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_get_service_metrics',
      options.approvals,
    ),
    execute: async ({
      projectId,
      serviceId,
      durationSeconds,
      metricTypes,
      containerName,
    }) => {
      const cName = nu(containerName);
      const result = await runApiCall(() =>
        client.get.service.metricsRange({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options), serviceId },
            options,
          ),
          options: {
            duration: nu(durationSeconds) ?? 900,
            metricTypes: (nu(metricTypes) ?? ['cpu', 'memory']) as any,
            ...(cName ? { containerName: cName } : {}),
          } as any,
        } as any),
      );
      if (!result.ok) return `Error fetching metrics: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  return [getServiceMetrics];
}
