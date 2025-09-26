// Browser-compatible process stub
export default {
  env: {
    NODE_ENV: 'production',
  },
  cwd: () => '/',
  platform: 'browser',
  version: 'v18.0.0',
  versions: {
    node: '18.0.0',
  },
  nextTick: (callback) => globalThis.setTimeout(callback, 0),
  exit: () => {
    throw new Error('process.exit() not available in browser');
  },
  argv: [],
  pid: 1,
  ppid: 0,
  title: 'browser',
  arch: 'x64',
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
  uptime: () => 0,
  hrtime: () => [0, 0],
  chdir: () => {
    throw new Error('process.chdir() not available in browser');
  },
  umask: () => 0,
  getuid: () => 0,
  getgid: () => 0,
  setuid: () => {
    throw new Error('process.setuid() not available in browser');
  },
  setgid: () => {
    throw new Error('process.setgid() not available in browser');
  },
  kill: () => {
    throw new Error('process.kill() not available in browser');
  },
  stdout: {
    write: (data) => globalThis.console.log(data),
    isTTY: false,
  },
  stderr: {
    write: (data) => globalThis.console.error(data),
    isTTY: false,
  },
  stdin: {
    read: () => null,
    isTTY: false,
  },
};
