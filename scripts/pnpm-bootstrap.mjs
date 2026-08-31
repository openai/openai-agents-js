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
