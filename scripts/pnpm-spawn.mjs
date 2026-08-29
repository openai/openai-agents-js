import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Spawn pnpm from a Node script in a way that also works on Windows.
 *
 * Node has refused to spawn `.cmd` and `.bat` files without a shell since 20.12.2,
 * 18.20.2 and 21.7.3, so `spawnSync('pnpm.cmd', args)` fails with EINVAL. The
 * obvious escape hatch does not work here either: with `shell: true` Node joins argv
 * with spaces and no quoting, so an argument such as `pnpm -r -F "@openai/*"
 * dist:check` arrives at pnpm as several arguments. Node 24 deprecates that
 * combination outright (DEP0190).
 *
 * So build the command line here and hand it to cmd.exe verbatim. That is what Node
 * does internally for `shell: true`, with the quoting it leaves out.
 */

// cmd.exe still expands %VAR% inside double quotes and there is no escape for it that
// survives both cmd.exe and CommandLineToArgvW. Callers pass repo-controlled argument
// lists, so refuse rather than corrupt the command line silently.
const UNQUOTABLE_FOR_CMD = /[%\r\n\0]/;

// Characters cmd.exe acts on. Quoting an argument is not enough on its own, because a
// quote inside the value closes the quoted region and exposes the rest of it to the
// command parser. Escaping the quotes themselves keeps cmd.exe out of quoted mode.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export function quoteWindowsArgument(value) {
  if (UNQUOTABLE_FOR_CMD.test(value)) {
    throw new Error(
      `pnpm argument cannot be quoted safely for cmd.exe: ${JSON.stringify(value)}`,
    );
  }

  // CommandLineToArgvW treats backslashes literally except when they precede a quote,
  // where each one has to be doubled. A trailing run needs the same treatment, since
  // the closing quote follows it.
  const quoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;

  // Escape twice. pnpm.cmd is a batch shim that forwards %* to another command, so the
  // first cmd.exe parse consumes one layer of carets and the shim's own expansion is
  // parsed again. A single layer leaves `name"&whoami&"` executing whoami.
  return quoted.replace(CMD_META_CHARS, '^$1').replace(CMD_META_CHARS, '^$1');
}

export function buildWindowsCommandLine(command, args) {
  // Deliberately leave `command` unquoted. cmd.exe sets %0 from the token it is given,
  // so a quoted bare name makes %~dp0 inside the pnpm shim resolve against the current
  // directory instead of the shim's own directory, and the shim then looks for its
  // corepack entrypoint on the wrong drive.
  return `"${[command, ...args.map(quoteWindowsArgument)].join(' ')}"`;
}

export function pnpmSpawnTarget(
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32') {
    return { command: 'pnpm', args, options: {} };
  }

  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildWindowsCommandLine('pnpm.cmd', args)],
    options: { windowsVerbatimArguments: true },
  };
}

export function spawnPnpmSync(args, options = {}) {
  const target = pnpmSpawnTarget(args);
  return spawnSync(target.command, target.args, {
    ...options,
    ...target.options,
  });
}
