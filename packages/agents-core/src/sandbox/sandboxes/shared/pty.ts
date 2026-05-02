import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { SandboxConfigurationError } from '../../errors';

const PTY_BRIDGE_UID_ENV = '__OPENAI_AGENTS_PTY_UID';
const PTY_BRIDGE_GID_ENV = '__OPENAI_AGENTS_PTY_GID';
const PTY_BRIDGE_PYTHON_CHECK_SCRIPT = String.raw`
import pty
import select
import signal
import sys

sys.exit(0 if sys.version_info[0] >= 3 else 1)
`;
const PTY_BRIDGE_SCRIPT = String.raw`
import errno
import os
import pty
import select
import signal
import sys

PTY_CHILD_SIGNAL_DEFAULTS = (signal.SIGINT, signal.SIGQUIT)

def restore_pty_child_signal_defaults():
    for signum in PTY_CHILD_SIGNAL_DEFAULTS:
        signal.signal(signum, signal.SIG_DFL)

executable = sys.argv[1]
argv = sys.argv[1:]
pid, fd = pty.fork()

if pid == 0:
    try:
        uid = os.environ.pop('__OPENAI_AGENTS_PTY_UID', '')
        gid = os.environ.pop('__OPENAI_AGENTS_PTY_GID', '')
        if gid:
            os.setgid(int(gid))
        if uid:
            os.setuid(int(uid))
        restore_pty_child_signal_defaults()
        os.execvpe(executable, argv, os.environ)
    except BaseException as exc:
        os.write(2, (str(exc) + '\n').encode())
        os._exit(127)

def forward_signal(signum, _frame):
    try:
        os.kill(pid, signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGTERM, forward_signal)
signal.signal(signal.SIGINT, forward_signal)

exit_status = 0
stdin_open = True

while True:
    readable = [fd]
    if stdin_open:
        readable.append(sys.stdin.fileno())
    try:
        ready, _, _ = select.select(readable, [], [], 0.1)
    except OSError:
        break

    if fd in ready:
        try:
            data = os.read(fd, 4096)
        except OSError as exc:
            if exc.errno == errno.EIO:
                data = b''
            else:
                raise
        if data:
            os.write(sys.stdout.fileno(), data)
        else:
            break

    if stdin_open and sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 4096)
        if data:
            os.write(fd, data)
        else:
            stdin_open = False

    waited_pid, status = os.waitpid(pid, os.WNOHANG)
    if waited_pid == pid:
        if os.WIFEXITED(status):
            exit_status = os.WEXITSTATUS(status)
        elif os.WIFSIGNALED(status):
            exit_status = 128 + os.WTERMSIG(status)
        break

try:
    _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        exit_status = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        exit_status = 128 + os.WTERMSIG(status)
except ChildProcessError:
    pass

sys.exit(exit_status)
`;

const checkedPtyBridgePythonExecutables = new Set<string>();

type PseudoTerminalSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
};

export function spawnInPseudoTerminal(
  executable: string,
  args: string[],
  options: PseudoTerminalSpawnOptions = {},
): ChildProcessWithoutNullStreams {
  const env = { ...(options.env ?? process.env) };
  const pythonExecutable = process.env.OPENAI_AGENTS_PYTHON ?? 'python3';
  assertPtyBridgePythonAvailable(pythonExecutable, {
    cwd: options.cwd,
    env,
  });

  if (typeof options.uid === 'number') {
    env[PTY_BRIDGE_UID_ENV] = String(options.uid);
  }
  if (typeof options.gid === 'number') {
    env[PTY_BRIDGE_GID_ENV] = String(options.gid);
  }

  return spawn(
    pythonExecutable,
    ['-c', PTY_BRIDGE_SCRIPT, executable, ...args],
    {
      cwd: options.cwd,
      env,
      stdio: 'pipe',
    },
  );
}

function assertPtyBridgePythonAvailable(
  pythonExecutable: string,
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
  },
): void {
  const cacheKey = `${pythonExecutable}\0${options.cwd ?? ''}\0${options.env.PATH ?? ''}`;
  if (checkedPtyBridgePythonExecutables.has(cacheKey)) {
    return;
  }

  const result = spawnSync(
    pythonExecutable,
    ['-c', PTY_BRIDGE_PYTHON_CHECK_SCRIPT],
    {
      cwd: options.cwd,
      env: options.env,
      stdio: 'pipe',
    },
  );
  if (result.error || result.status !== 0) {
    throw new SandboxConfigurationError(
      'PTY support requires Python 3. Install python3 or set OPENAI_AGENTS_PYTHON to a Python 3 executable.',
      {
        pythonExecutable,
        cwd: options.cwd,
        path: options.env.PATH,
        status: result.status,
        signal: result.signal,
        error: result.error?.message,
        stderr: result.stderr?.toString('utf8').trim() ?? '',
      },
    );
  }

  checkedPtyBridgePythonExecutables.add(cacheKey);
}
