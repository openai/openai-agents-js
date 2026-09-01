import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Install dependencies before Execa is available to import.
 *
 * Node has refused to spawn `.cmd` and `.bat` files without a shell since 20.12.2,
 * 18.20.2 and 21.7.3, so `spawnSync('pnpm.cmd', args)` fails with EINVAL. Execa resolves
 * Windows shims and quotes arguments itself, but it lives in `node_modules`, which does
 * not exist yet on a clean checkout. Only the install step falls in that gap, and it
 * takes no caller-supplied arguments, so a fixed command line closes it without any
 * quoting of our own.
 */

export const BOOTSTRAP_INSTALL_ARGS = ['i', '--frozen-lockfile'];

export function bootstrapInstallTarget(
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32') {
    return { command: 'pnpm', args: BOOTSTRAP_INSTALL_ARGS, options: {} };
  }

  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"pnpm.cmd ${BOOTSTRAP_INSTALL_ARGS.join(' ')}"`],
    options: { windowsVerbatimArguments: true },
  };
}

export function runBootstrapInstall(options = {}) {
  const target = bootstrapInstallTarget();
  return spawnSync(target.command, target.args, {
    ...options,
    ...target.options,
  });
}

/**
 * Normalise an Execa result into the fields a caller needs to report an exit.
 *
 * With `reject: false` Execa returns its error rather than throwing, and a process that
 * never started has no `exitCode` and no `signal`. Reading `exitCode` alone turns a
 * missing pnpm into "terminated by an unknown signal" and drops the startup error that
 * `spawnSync` used to expose through `result.error`.
 */
export function execaRunOutcome(result) {
  if (result.isTerminated) {
    return { exitCode: undefined, signal: result.signal };
  }
  if (typeof result.exitCode === 'number') {
    return { exitCode: result.exitCode, signal: undefined };
  }

  return {
    exitCode: undefined,
    signal: undefined,
    spawnError: result.originalMessage ?? result.shortMessage ?? result.message,
  };
}
