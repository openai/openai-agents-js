/* eslint-disable @typescript-eslint/no-require-imports -- Node loads the native addon through this CommonJS entrypoint. */
/* global require, module, __dirname, process */
const binding = require('./codex.node');
const { join } = require('node:path');

Object.defineProperty(binding, '_packaged_runtime', {
  value: () => {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const executable = (name) => join(__dirname, '..', 'bin', name + suffix);
    return {
      codex_self_exe: executable('codex-sdk-runtime'),
      code_mode_host_exe: executable('codex-code-mode-host'),
      ...(process.platform === 'linux'
        ? { codex_linux_sandbox_exe: executable('codex-linux-sandbox') }
        : {}),
      ...(process.platform !== 'win32'
        ? { main_execve_wrapper_exe: executable('codex-execve-wrapper') }
        : {}),
    };
  },
});

module.exports = binding;
