/* eslint-disable @typescript-eslint/no-require-imports -- Node loads the native addon through this CommonJS entrypoint. */
/* global require, module, __dirname, process */
const { join } = require('node:path');

let binding;
try {
  binding = require('./codex.node');
} catch (error) {
  const code = error?.code;
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_DLOPEN_FAILED') {
    throw error;
  }
  throw Object.assign(
    new Error(
      `Could not load the OpenAI Agents SDK native addon on ${process.platform}/${process.arch}. Install the native bundle for this platform and architecture, or build the SDK from source on a supported target. Original loader error: ${error.message}`,
      { cause: error },
    ),
    { code },
  );
}

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
