import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const PTY_BRIDGE_UID_ENV = '__OPENAI_AGENTS_PTY_UID';
const PTY_BRIDGE_GID_ENV = '__OPENAI_AGENTS_PTY_GID';
const PTY_BRIDGE_SCRIPT = String.raw`
import errno
import os
import pty
import select
import signal
import sys

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
  if (typeof options.uid === 'number') {
    env[PTY_BRIDGE_UID_ENV] = String(options.uid);
  }
  if (typeof options.gid === 'number') {
    env[PTY_BRIDGE_GID_ENV] = String(options.gid);
  }

  return spawn(
    process.env.OPENAI_AGENTS_PYTHON ?? 'python3',
    ['-c', PTY_BRIDGE_SCRIPT, executable, ...args],
    {
      cwd: options.cwd,
      env,
      stdio: 'pipe',
    },
  );
}
