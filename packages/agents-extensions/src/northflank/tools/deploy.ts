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
 * Build the parameter schema for tools whose body is an open-ended JSON object
 * (`create_service`, `update_service_deployment`, `start_service_build`). The
 * Northflank service spec is too rich to enumerate field-by-field, so we
 * opt out of OpenAI Structured Outputs strict mode for these three.
 *
 * Strict mode requires `additionalProperties: false` on every object, which
 * forbids the catch-all `body` payload. Non-strict mode requires a JSON
 * schema (Zod is not supported) with `additionalProperties: true`. We
 * generate the schema by hand so it matches the JS-client request shape.
 *
 * `defaultProjectId` makes `projectId` non-required so the model can omit it.
 */
function buildBodySchema(
  options: NorthflankToolsOptions,
  extra: Record<string, { type: string; description: string }> = {},
) {
  const projectIdDescription = options.defaultProjectId
    ? 'Northflank project ID. Optional — defaults to the configured project.'
    : 'Northflank project ID.';
  const properties: Record<string, unknown> = {
    projectId: { type: 'string', description: projectIdDescription },
    ...extra,
    body: {
      type: 'object',
      description: 'Pass-through payload for the Northflank API call.',
      additionalProperties: true,
    },
  };
  const required: string[] = ['body', ...Object.keys(extra)];
  if (!options.defaultProjectId) required.unshift('projectId');
  return {
    type: 'object' as const,
    properties,
    required,
    additionalProperties: true as const,
  };
}

/**
 * Deployment / lifecycle tools — all mutating, so all default to needing approval.
 */
export function buildDeployTools(
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

  const createService = tool({
    name: 'northflank_create_service',
    description:
      'Create a new Northflank deployment service from a pre-built container image. `body` follows the Northflank `POST /projects/{projectId}/services/deployment` schema (name, billing.deploymentPlan, deployment.instances, deployment.external.imagePath, ports, runtimeEnvironment).',
    strict: false,
    parameters: buildBodySchema(options),
    needsApproval: resolveNeedsApproval(
      'northflank_create_service',
      options.approvals,
    ),
    execute: async (rawInput) => {
      const input = rawInput as {
        projectId?: string;
        body: Record<string, unknown>;
      };
      const result = await runApiCall(() =>
        client.create.service.deployment({
          parameters: buildParams(
            { projectId: resolveProjectId(input.projectId, options) },
            options,
          ),
          data: input.body as any,
        } as any),
      );
      if (!result.ok) return `Error creating service: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const updateServiceDeployment = tool({
    name: 'northflank_update_service_deployment',
    description:
      'Update the deployment of an existing service — e.g. change the container image, git source, or roll out a new tag. Mirrors `PATCH /projects/{projectId}/services/{serviceId}/deployment`. Typical body: `{ "external": { "imagePath": "registry/image:tag" } }` or `{ "internal": { "buildSHA": "<sha>" } }`.',
    strict: false,
    parameters: buildBodySchema(options, {
      serviceId: { type: 'string', description: 'Service ID to update.' },
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_update_service_deployment',
      options.approvals,
    ),
    execute: async (rawInput) => {
      const input = rawInput as {
        projectId?: string;
        serviceId: string;
        body: Record<string, unknown>;
      };
      const result = await runApiCall(() =>
        client.patch.service.deployment({
          parameters: buildParams(
            {
              projectId: resolveProjectId(input.projectId, options),
              serviceId: input.serviceId,
            },
            options,
          ),
          data: input.body as any,
        } as any),
      );
      if (!result.ok) return `Error updating deployment: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const startServiceBuild = tool({
    name: 'northflank_start_service_build',
    description:
      'Trigger a new build for a combined or git-backed service. Optionally specify a branch, commit SHA, or extra build fields (build arguments etc.) via `buildOverrides`.',
    strict: false,
    parameters: {
      type: 'object' as const,
      properties: {
        projectId: {
          type: 'string',
          description: options.defaultProjectId
            ? 'Northflank project ID. Optional — defaults to the configured project.'
            : 'Northflank project ID.',
        },
        serviceId: { type: 'string', description: 'Service ID.' },
        branch: {
          type: 'string',
          description: 'Git branch to build. Omit to use the service default.',
        },
        commitSha: {
          type: 'string',
          description:
            'Specific commit SHA to build. Omit to use the branch head.',
        },
        buildOverrides: {
          type: 'object',
          description:
            'Additional StartServiceBuild fields (build arguments etc.). Omit when none.',
          additionalProperties: true,
        },
      },
      required: options.defaultProjectId
        ? ['serviceId']
        : ['projectId', 'serviceId'],
      additionalProperties: true as const,
    },
    needsApproval: resolveNeedsApproval(
      'northflank_start_service_build',
      options.approvals,
    ),
    execute: async (rawInput) => {
      const input = rawInput as {
        projectId?: string;
        serviceId: string;
        branch?: string;
        commitSha?: string;
        buildOverrides?: Record<string, unknown>;
      };
      const data: Record<string, unknown> = { ...(input.buildOverrides ?? {}) };
      if (input.branch) data.branch = input.branch;
      if (input.commitSha) data.sha = input.commitSha;
      const result = await runApiCall(() =>
        client.start.service.build({
          parameters: buildParams(
            {
              projectId: resolveProjectId(input.projectId, options),
              serviceId: input.serviceId,
            },
            options,
          ),
          data: data as any,
        } as any),
      );
      if (!result.ok) return `Error starting build: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const restartService = tool({
    name: 'northflank_restart_service',
    description:
      'Restart a Northflank service. All running instances are recreated, rolling per the service strategy.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Service ID to restart.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_restart_service',
      options.approvals,
    ),
    execute: async ({ projectId, serviceId }) => {
      const result = await runApiCall(() =>
        client.restart.service({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options), serviceId },
            options,
          ),
        } as any),
      );
      if (!result.ok) return `Error restarting service: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const scaleService = tool({
    name: 'northflank_scale_service',
    description:
      'Scale a service to a target instance count. Northflank will roll the new replicas according to the service strategy.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Service ID to scale.'),
      instances: z
        .number()
        .int()
        .min(0)
        .max(100)
        .describe('Target replica count (0–100).'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_scale_service',
      options.approvals,
    ),
    execute: async ({ projectId, serviceId, instances }) => {
      const result = await runApiCall(() =>
        client.scale.service({
          parameters: buildParams(
            { projectId: resolveProjectId(nu(projectId), options), serviceId },
            options,
          ),
          data: { instances } as any,
        } as any),
      );
      if (!result.ok) return `Error scaling service: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  return [
    createService,
    updateServiceDeployment,
    startServiceBuild,
    restartService,
    scaleService,
  ];
}
