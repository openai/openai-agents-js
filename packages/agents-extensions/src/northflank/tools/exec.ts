import type { ApiClient } from '@northflank/js-client';
import { tool } from '@openai/agents-core';
import { z } from 'zod';

import type { NorthflankTool, NorthflankToolsOptions } from '../types';
import {
  compact,
  DEFAULT_OUTPUT_LIMIT,
  nu,
  resolveNeedsApproval,
  resolveProjectId,
  runSafe,
  truncate,
} from '../util';

/**
 * Wrap a user-supplied shell command as an argv array the Northflank exec
 * API can run reliably. The API does NOT apply a shell by default — a raw
 * string like `cd /foo && ls` would be exec'd as a single binary name. We
 * shell out via `<shell> -lc "<command>"` so pipes, redirects and `&&`
 * behave as expected.
 *
 * `shell` defaults to `sh` (override per call: `bash`, `zsh`, etc.).
 */
function shellArgv(command: string, shell?: string): string[] {
  const interp = (shell ?? 'sh').trim() || 'sh';
  const argv = interp.split(/\s+/);
  const last = argv[argv.length - 1];
  // Default to `sh -c` — many minimal `/bin/sh` builds don't accept `-l`.
  // Callers who want a login shell can pass e.g. `'bash -lc'` explicitly.
  if (last === '-c' || last === '-lc') return [...argv, command];
  return [...argv, '-c', command];
}

/**
 * Format the result of a one-shot exec call into a single string the model
 * can read. We label stdout/stderr distinctly and report the exit code on the
 * top line so the agent can branch on success without parsing.
 *
 * The total budget is split evenly between stdout and stderr so a noisy
 * stream can't blow past `outputCharLimit`. If one stream is empty the other
 * still only gets half — keeps the contract predictable. Note that the
 * fixed header / delimiter lines (~40 chars) are NOT counted against the
 * budget, so total output can exceed `outputCharLimit` by that small fixed
 * amount.
 */
function formatExecResult(
  result: {
    commandResult: { exitCode: number; status: string; message?: string };
    stdOut: string;
    stdErr: string;
  },
  totalLimit: number,
): string {
  const halfLimit = Math.floor(totalLimit / 2);
  const header = `exitCode=${result.commandResult.exitCode} status=${result.commandResult.status}${
    result.commandResult.message
      ? ` message=${result.commandResult.message}`
      : ''
  }`;
  const stdout = truncate(result.stdOut ?? '', halfLimit);
  const stderr = truncate(result.stdErr ?? '', halfLimit);
  return [
    header,
    '--- stdout ---',
    stdout || '(empty)',
    '--- stderr ---',
    stderr || '(empty)',
  ].join('\n');
}

/**
 * One-shot exec tools for services, jobs, and addons.
 *
 * These are powerful — they run arbitrary shell inside a running container —
 * so they all require approval by default. Use the `approvals` option to relax
 * if you have an external policy engine.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export function buildExecTools(
  client: ApiClient,
  options: NorthflankToolsOptions,
): NorthflankTool[] {
  const limit = options.outputCharLimit ?? DEFAULT_OUTPUT_LIMIT;
  const timeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const projectIdSchema = options.defaultProjectId
    ? z
        .string()
        .nullable()
        .optional()
        .describe(
          'Northflank project ID. Defaults to the configured project — pass null to use the default.',
        )
    : z.string().describe('Northflank project ID.');

  const commandSchema = z
    .string()
    .describe(
      'Shell command to execute, e.g. "ls -la /app" or "node scripts/migrate.js".',
    );
  const shellSchema = z
    .string()
    .nullable()
    .optional()
    .describe(
      'Shell wrapper, e.g. "bash -c". Pass null for the container default.',
    );
  const instanceNameSchema = z
    .string()
    .nullable()
    .optional()
    .describe(
      'Specific pod/instance to target. Pass null to let Northflank pick.',
    );
  const containerNameSchema = z
    .string()
    .nullable()
    .optional()
    .describe(
      'Container within the instance (multi-container pods). Pass null for the default.',
    );

  const execService = tool({
    name: 'northflank_exec_service',
    description:
      'Run a one-shot shell command inside a running instance of a Northflank service and return stdout/stderr/exit code. Output is capped — keep commands focused.',
    parameters: z.object({
      projectId: projectIdSchema,
      serviceId: z.string().describe('Service ID.'),
      command: commandSchema,
      shell: shellSchema,
      instanceName: instanceNameSchema,
      containerName: containerNameSchema,
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_exec_service',
      options.approvals,
    ),
    timeoutMs,
    execute: async ({
      projectId,
      serviceId,
      command,
      shell,
      instanceName,
      containerName,
    }) => {
      const result = await runSafe(() =>
        client.exec.execServiceCommand(
          {
            projectId: resolveProjectId(nu(projectId), options),
            serviceId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          {
            command: shellArgv(command, nu(shell)),
            shell: 'none',
            ...compact({
              instanceName: nu(instanceName),
              containerName: nu(containerName),
            }),
          },
        ),
      );
      if (!result.ok) return `Error executing on service: ${result.error}`;
      return formatExecResult(result.value, limit);
    },
  });

  const execJob = tool({
    name: 'northflank_exec_job',
    description:
      'Run a one-shot shell command inside a running instance of a Northflank job (useful for cron jobs that have an active run).',
    parameters: z.object({
      projectId: projectIdSchema,
      jobId: z.string().describe('Job ID.'),
      command: commandSchema,
      shell: shellSchema,
      instanceName: instanceNameSchema,
      containerName: containerNameSchema,
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_exec_job',
      options.approvals,
    ),
    timeoutMs,
    execute: async ({
      projectId,
      jobId,
      command,
      shell,
      instanceName,
      containerName,
    }) => {
      const result = await runSafe(() =>
        client.exec.execJobCommand(
          {
            projectId: resolveProjectId(nu(projectId), options),
            jobId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          {
            command: shellArgv(command, nu(shell)),
            shell: 'none',
            ...compact({
              instanceName: nu(instanceName),
              containerName: nu(containerName),
            }),
          },
        ),
      );
      if (!result.ok) return `Error executing on job: ${result.error}`;
      return formatExecResult(result.value, limit);
    },
  });

  const execAddon = tool({
    name: 'northflank_exec_addon',
    description:
      'Run a one-shot shell command inside a Northflank addon instance (e.g. for running `psql` against a Postgres addon). `instanceName` is required to disambiguate replicas.',
    parameters: z.object({
      projectId: projectIdSchema,
      addonId: z.string().describe('Addon ID.'),
      command: commandSchema,
      instanceName: z
        .string()
        .describe(
          'Specific addon instance (replica) to target. Required for addons.',
        ),
      shell: shellSchema,
      containerName: containerNameSchema,
    }),
    needsApproval: resolveNeedsApproval(
      'northflank_exec_addon',
      options.approvals,
    ),
    timeoutMs,
    execute: async ({
      projectId,
      addonId,
      command,
      shell,
      instanceName,
      containerName,
    }) => {
      const result = await runSafe(() =>
        client.exec.execAddonCommand(
          {
            projectId: resolveProjectId(nu(projectId), options),
            addonId,
            ...(options.teamId ? { teamId: options.teamId } : {}),
          },
          {
            command: shellArgv(command, nu(shell)),
            shell: 'none',
            instanceName,
            ...compact({
              containerName: nu(containerName),
            }),
          },
        ),
      );
      if (!result.ok) return `Error executing on addon: ${result.error}`;
      return formatExecResult(result.value, limit);
    },
  });

  return [execService, execJob, execAddon];
}
