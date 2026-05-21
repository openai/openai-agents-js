import type { ApiClient } from '@northflank/js-client';
import type { Shell, ShellAction, ShellResult } from '@openai/agents-core';

/**
 * Identifies the Northflank container that a `NorthflankShell` should execute
 * commands inside. The three variants mirror the Northflank JS-client exec API
 * (`execServiceCommand` / `execJobCommand` / `execAddonCommand`).
 *
 * Common optional fields:
 * - `teamId` — scope the API call to a team / org
 * - `instanceName` — target a specific replica (mandatory for addons)
 * - `containerName` — target a specific container inside the pod
 * - `shell` — shell wrapper, e.g. `"bash -c"`. Defaults to the container default.
 */
export type NorthflankShellTarget =
  | {
      type: 'service';
      projectId: string;
      serviceId: string;
      teamId?: string;
      instanceName?: string;
      containerName?: string;
      shell?: string;
    }
  | {
      type: 'job';
      projectId: string;
      jobId: string;
      teamId?: string;
      instanceName?: string;
      containerName?: string;
      shell?: string;
    }
  | {
      type: 'addon';
      projectId: string;
      addonId: string;
      teamId?: string;
      /** Addons require an explicit instanceName to disambiguate replicas. */
      instanceName: string;
      containerName?: string;
      shell?: string;
    };

export interface NorthflankShellOptions {
  /** A constructed Northflank `ApiClient`. */
  client: ApiClient;
  /** The container the shell targets. */
  target: NorthflankShellTarget;
}

/**
 * Cap each captured stream at `limit` chars (default 20k). Adds a marker so
 * the model can detect truncation and adapt.
 */
function clip(s: string | undefined, limit: number): string {
  const str = s ?? '';
  if (str.length <= limit) return str;
  return `${str.slice(0, limit)}\n... [truncated ${str.length - limit} chars]`;
}

const DEFAULT_OUTPUT_LIMIT = 20_000;

/**
 * `Shell` implementation that proxies commands to a running Northflank
 * container via `client.exec.execServiceCommand` / `execJobCommand` /
 * `execAddonCommand`.
 *
 * Wire it into the hosted shell tool:
 *
 * ```ts
 * const shell = new NorthflankShell({
 *   client,
 *   target: { type: 'service', projectId: 'p', serviceId: 's' },
 * });
 *
 * const agent = new Agent({
 *   name: 'Service Operator',
 *   tools: [shellTool({ shell, needsApproval: true })],
 * });
 * ```
 *
 * Each entry in `action.commands` is forwarded as one Northflank exec call,
 * sequentially. The Shell protocol expresses the same string commands the
 * model would type in a terminal; we let the container's default shell parse
 * them unless `target.shell` overrides it.
 */
export class NorthflankShell implements Shell {
  constructor(private readonly options: NorthflankShellOptions) {}

  async run(action: ShellAction): Promise<ShellResult> {
    const maxOutputLength = action.maxOutputLength ?? DEFAULT_OUTPUT_LIMIT;
    const halfLimit = Math.floor(maxOutputLength / 2);
    const output: ShellResult['output'] = [];

    for (const command of action.commands) {
      const run = this.execOne(command);
      const result = action.timeoutMs
        ? await raceWithTimeout(run, action.timeoutMs)
        : await run
            .then((value) => ({ kind: 'done' as const, value }))
            .catch((err) => ({
              kind: 'error' as const,
              err,
            }));

      if (result.kind === 'timeout') {
        // Stop processing the rest of the batch on timeout, mirroring the
        // Responses API local-shell contract.
        output.push({
          command,
          stdout: '',
          stderr: '',
          outcome: { type: 'timeout' },
        });
        break;
      }

      if (result.kind === 'error') {
        const message =
          result.err instanceof Error ? result.err.message : String(result.err);
        output.push({
          command,
          stdout: '',
          stderr: message,
          outcome: { type: 'exit', exitCode: null },
        });
        continue;
      }

      const { commandResult, stdOut, stdErr } = result.value;
      output.push({
        command,
        stdout: clip(stdOut, halfLimit),
        stderr: clip(stdErr, halfLimit),
        outcome: { type: 'exit', exitCode: commandResult.exitCode },
      });
    }

    return {
      output,
      maxOutputLength,
      providerData: {
        target: this.options.target.type,
        projectId: this.options.target.projectId,
      },
    };
  }

  /**
   * Dispatch a single command to the right Northflank exec endpoint.
   *
   * Northflank's exec API does NOT wrap commands in a shell by default — a
   * raw `command: "cd /foo && ls"` string would be exec'd as a literal
   * binary name and fail with ENOENT. We always send the command as an
   * argv array `[<shell>, "-lc", <user_command>]` so pipes / redirects /
   * `&&` work as the model expects.
   */
  private async execOne(command: string): Promise<{
    commandResult: { exitCode: number; status: string; message?: string };
    stdOut: string;
    stdErr: string;
  }> {
    const { client, target } = this.options;
    const teamId = target.teamId ? { teamId: target.teamId } : {};
    const argv = buildShellArgv(command, target.shell);

    const data = {
      command: argv,
      shell: 'none',
      ...stripUndefined({
        instanceName: target.instanceName,
        containerName: target.containerName,
      }),
    };

    switch (target.type) {
      case 'service':
        return client.exec.execServiceCommand(
          {
            projectId: target.projectId,
            serviceId: target.serviceId,
            ...teamId,
          },
          data,
        );
      case 'job':
        return client.exec.execJobCommand(
          { projectId: target.projectId, jobId: target.jobId, ...teamId },
          data,
        );
      case 'addon':
        // ExecCommandDataAddon requires instanceName — TS can narrow via the
        // discriminant, but the spread loses that info. Cast is safe because
        // the NorthflankShellTarget addon variant requires instanceName.
        return client.exec.execAddonCommand(
          { projectId: target.projectId, addonId: target.addonId, ...teamId },
          data as typeof data & { instanceName: string },
        );
    }
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * Build the argv that wraps a user shell command. Defaults to `sh -c`
 * because many minimal `/bin/sh` builds don't accept `-l`. Callers who
 * want a login shell can opt in by passing `'bash -lc'` (or any explicit
 * invocation ending in `-c` / `-lc`); we don't double-append the flag.
 */
function buildShellArgv(command: string, shell?: string): string[] {
  const interp = (shell ?? 'sh').trim() || 'sh';
  const shellArgv = interp.split(/\s+/);
  const last = shellArgv[shellArgv.length - 1];
  if (last === '-c' || last === '-lc') return [...shellArgv, command];
  return [...shellArgv, '-c', command];
}

type RaceResult<T> =
  | { kind: 'done'; value: T }
  | { kind: 'error'; err: unknown }
  | { kind: 'timeout' };

/**
 * Race a promise against a wall-clock timeout. We can't actually cancel the
 * Northflank exec call from the client, but we can stop waiting for it so the
 * agent run keeps moving. The orphaned exec will eventually settle on the
 * Northflank side.
 */
async function raceWithTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<RaceResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RaceResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const wrapped = p
    .then<RaceResult<T>>((value) => ({ kind: 'done', value }))
    .catch<RaceResult<T>>((err) => ({ kind: 'error', err }));
  try {
    return await Promise.race([wrapped, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
