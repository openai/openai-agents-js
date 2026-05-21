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
 * Read-only inspection tools. Safe to enable without approval.
 */
export function buildReadTools(
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

  const listProjects = tool({
    name: 'northflank_list_projects',
    description:
      'List Northflank projects the authenticated principal can see. Returns id, name, region, and description for each project. Supports pagination via the page argument.',
    parameters: z.object({
      page: z
        .number()
        .int()
        .min(1)
        .nullable()
        .optional()
        .describe(
          '1-indexed page number (max 100 results per page). Pass null for the first page.',
        ),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_list_projects',
      options.approvals,
    ),
    execute: async ({ page }) => {
      const result = await runApiCall(() =>
        client.list.projects({
          parameters: options.teamId ? { teamId: options.teamId } : undefined,
          options: nu(page) != null ? { page: nu(page)! } : undefined,
        } as any),
      );
      if (!result.ok) return `Error listing projects: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const getProject = tool({
    name: 'northflank_get_project',
    description:
      'Get the details of a single Northflank project by id (cluster, region, networking, members).',
    parameters: z.object({
      projectId: projectIdSchema,
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_get_project',
      options.approvals,
    ),
    execute: async ({ projectId }) => {
      const result = await runApiCall(() =>
        client.get.project({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options) },
            options,
          ),
        } as any),
      );
      if (!result.ok) return `Error fetching project: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const listServices = tool({
    name: 'northflank_list_services',
    description:
      'List all services in a Northflank project. Returns id, name, type (deployment/combined/external), and status for each service.',
    parameters: z.object({
      projectId: projectIdSchema,
      page: z
        .number()
        .int()
        .min(1)
        .nullable()
        .optional()
        .describe('1-indexed page number. Pass null for the first page.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_list_services',
      options.approvals,
    ),
    execute: async ({ projectId, page }) => {
      const result = await runApiCall(() =>
        client.list.services({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options) },
            options,
          ),
          options: nu(page) != null ? { page: nu(page)! } : undefined,
        } as any),
      );
      if (!result.ok) return `Error listing services: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const getService = tool({
    name: 'northflank_get_service',
    description:
      'Get the full configuration and status of a single Northflank service: image, ports, env, deployment, replica counts.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('The service ID within the project.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_get_service',
      options.approvals,
    ),
    execute: async ({ projectId, serviceId }) => {
      const result = await runApiCall(() =>
        client.get.service({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options), serviceId },
            options,
          ),
        } as any),
      );
      if (!result.ok) return `Error fetching service: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  return [listProjects, getProject, listServices, getService];
}
