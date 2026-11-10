// Native v1 objects share the CommonJS implementation. Core sandbox authority
// stays in the ESM graph used by ESM applications and the sandbox facade.
export * from '../dist/index.js';
import * as sandboxRuntime from '@openai/agents-core/sandbox/internal';
import {
  sandboxEnvironmentWithRuntime,
  renderStorageLayoutWithManifest,
} from '../dist/runtime/sandbox-environment.js';

export function sandboxEnvironment(options) {
  return sandboxEnvironmentWithRuntime(options, sandboxRuntime);
}

export function renderStorageLayout(manifest) {
  return renderStorageLayoutWithManifest(manifest, sandboxRuntime.Manifest);
}
