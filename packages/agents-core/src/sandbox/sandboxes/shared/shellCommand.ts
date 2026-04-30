import { existsSync } from 'node:fs';

export type ResolvedShellCommand = {
  shellPath: string;
  flag: '-lc' | '-c';
};

export function resolveLocalShellCommand(args: {
  shell?: string;
  defaultShell?: string;
  envShell?: string;
  login: boolean;
  bashPaths?: string[];
}): ResolvedShellCommand {
  const configuredShell = firstNonEmpty(
    args.shell,
    args.defaultShell,
    args.envShell,
  );
  if (configuredShell) {
    return shellCommand(configuredShell, args.login);
  }

  if (args.login) {
    const bashShell = firstExistingPath(
      args.bashPaths ?? ['/bin/bash', '/usr/bin/bash'],
    );
    if (bashShell) {
      return shellCommand(bashShell, true);
    }
  }

  return shellCommand('/bin/sh', false);
}

export function resolveFallbackShellCommand(args: {
  shell?: string;
  defaultShell?: string;
  fallbackShell?: string;
  login: boolean;
}): ResolvedShellCommand {
  const configuredShell = firstNonEmpty(args.shell, args.defaultShell);
  if (configuredShell) {
    return shellCommand(configuredShell, args.login);
  }

  return shellCommand(args.fallbackShell ?? '/bin/sh', false);
}

function shellCommand(shellPath: string, login: boolean): ResolvedShellCommand {
  return {
    shellPath,
    flag: login ? '-lc' : '-c',
  };
}

function firstExistingPath(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0);
}
