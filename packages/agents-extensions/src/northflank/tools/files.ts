import type { ApiClient } from '@northflank/js-client';
import { tool } from '@openai/agents-core';
import { z } from 'zod';

import type { NorthflankTool, NorthflankToolsOptions } from '../types';
import {
  compact,
  jsonResult,
  nu,
  resolveNeedsApproval,
  resolveProjectId,
  runSafe,
} from '../util';

/**
 * File copy tools. The agent passes local + remote paths; the JS client
 * archives/streams the files. The agent host filesystem is the source/sink,
 * so deployments where the agent runs in a sandbox are the typical use case.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 300_000;

export function buildFileTools(
  client: ApiClient,
  options: NorthflankToolsOptions,
): NorthflankTool[] {
  const timeoutMs = options.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  const projectIdSchema = options.defaultProjectId
    ? z
        .string()
        .nullable()
        .optional()
        .describe(
          'Northflank project ID. Defaults to the configured project — pass null to use the default.',
        )
    : z.string().describe('Northflank project ID.');

  const uploadFiles = tool({
    name: 'northflank_upload_files',
    description:
      'Upload a local file or directory into a running Northflank service instance. Useful for pushing patches, fixtures, or scripts before exec.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Target service ID.'),
      localPath: z
        .string()
        .describe('Absolute path on the agent host to upload from.'),
      remotePath: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Destination path inside the container. Pass null to use the working directory.',
        ),
      instanceName: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Specific instance to target. Pass null to let Northflank pick.',
        ),
      containerName: z
        .string()
        .nullable()
        .optional()
        .describe('Container in multi-container pods. Pass null for default.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_upload_files',
      options.approvals,
    ),
    timeoutMs,
    execute: async ({
      projectId,
      serviceId,
      localPath,
      remotePath,
      instanceName,
      containerName,
    }) => {
      const result = await runSafe(() =>
        client.fileCopy.uploadServiceFiles(
          {
            projectId: resolveProjectId(nu(projectId), options),
            serviceId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          {
            localPath,
            ...compact({
              remotePath: nu(remotePath),
              instanceName: nu(instanceName),
              containerName: nu(containerName),
            }),
          },
        ),
      );
      if (!result.ok) return `Error uploading files: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  const downloadFiles = tool({
    name: 'northflank_download_files',
    description:
      'Download a file or directory from a running Northflank service instance to the agent host. Useful for fetching logs, dumps, or artifacts.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Source service ID.'),
      localPath: z
        .string()
        .describe('Absolute path on the agent host to download into.'),
      remotePath: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Path inside the container to copy from. Pass null for the working directory.',
        ),
      instanceName: z
        .string()
        .nullable()
        .optional()
        .describe(
          'Specific instance to target. Pass null to let Northflank pick.',
        ),
      containerName: z
        .string()
        .nullable()
        .optional()
        .describe('Container in multi-container pods. Pass null for default.'),
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_download_files',
      options.approvals,
    ),
    timeoutMs,
    execute: async ({
      projectId,
      serviceId,
      localPath,
      remotePath,
      instanceName,
      containerName,
    }) => {
      const result = await runSafe(() =>
        client.fileCopy.downloadServiceFiles(
          {
            projectId: resolveProjectId(nu(projectId), options),
            serviceId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          {
            localPath,
            ...compact({
              remotePath: nu(remotePath),
              instanceName: nu(instanceName),
              containerName: nu(containerName),
            }),
          },
        ),
      );
      if (!result.ok) return `Error downloading files: ${result.error}`;
      return jsonResult(result.value, options.outputCharLimit);
    },
  });

  return [uploadFiles, downloadFiles];
}
