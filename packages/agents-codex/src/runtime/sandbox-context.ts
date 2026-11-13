import type {
  ExecCommandArgs,
  SandboxExecResult,
  SandboxSessionLike,
  WriteStdinArgs,
} from '@openai/agents-core/sandbox';
import type { ApplyPatchEditor, ApplyPatchOperation } from './apply-patch';
import type { Environment } from './environment';

/** Application operations on the provider resource acquired for this Session.
 * These calls use provider permissions, independently of native executor policy.
 */
export interface SandboxAccess {
  exec(args: ExecCommandArgs): Promise<SandboxExecResult>;
  execCommand(args: ExecCommandArgs): Promise<string>;
  writeStdin(args: WriteStdinArgs): Promise<string>;
  createEditor(runAs?: string): ApplyPatchEditor;
}

/** @internal Non-owning authority; the Environment lease retains resource cleanup. */
export class SandboxProviderBinding {
  private active = true;
  constructor(
    readonly sandbox: SandboxSessionLike,
    readonly environment: Environment,
  ) {}
  retire(): void {
    this.active = false;
  }
  check(): void {
    if (!this.active) throw new Error('Sandbox resource has retired');
  }
}

const contexts = new WeakMap<
  object,
  { binding: SandboxProviderBinding; check: () => boolean }
>();

/** @internal The native dispatcher supplies the exact admitted callback check. */
export function bindSandboxContext(
  context: object & { signal: AbortSignal },
  binding: SandboxProviderBinding,
  check: () => boolean,
): void {
  contexts.set(context, { binding, check });
  let access: SandboxAccess | undefined;
  Object.defineProperty(context, 'sandbox', {
    enumerable: true,
    configurable: true,
    get: () => (access ??= sandboxAccess(binding, context.signal, check)),
  });
}

/** @internal Body deadlines use their own signal while preserving native authority. */
export function inheritSandboxContext(context: object, source: object): void {
  const captured = contexts.get(source);
  if (captured)
    bindSandboxContext(
      context as { signal: AbortSignal },
      captured.binding,
      captured.check,
    );
}

function sandboxAccess(
  binding: SandboxProviderBinding,
  signal: AbortSignal,
  admitted: () => boolean,
): SandboxAccess {
  const check = () => {
    signal.throwIfAborted();
    binding.check();
    if (!admitted()) throw new Error('Sandbox callback is no longer admitted');
  };
  const invoke = async <T>(body: () => T | Promise<T>): Promise<T> => {
    check();
    try {
      const result = await body();
      check();
      return result;
    } catch (error) {
      check();
      throw error;
    }
  };
  const sandbox = binding.sandbox;
  return Object.freeze({
    exec: (args: ExecCommandArgs) =>
      invoke(() => {
        if (!sandbox.exec)
          throw new TypeError(
            'Sandbox provider does not support structured execution',
          );
        return sandbox.exec(args);
      }),
    execCommand: (args: ExecCommandArgs) =>
      invoke(() => {
        if (!sandbox.execCommand)
          throw new TypeError(
            'Sandbox provider does not support command execution',
          );
        return sandbox.execCommand(args);
      }),
    writeStdin: (args: WriteStdinArgs) =>
      invoke(() => {
        if (!sandbox.writeStdin)
          throw new TypeError(
            'Sandbox provider does not support process input',
          );
        return sandbox.writeStdin(args);
      }),
    createEditor: (runAs?: string): ApplyPatchEditor => {
      check();
      if (!sandbox.createEditor)
        throw new TypeError('Sandbox provider does not support editors');
      const editor = sandbox.createEditor(runAs);
      return Object.freeze({
        createFile: (operation: ApplyPatchOperation) =>
          invoke(() => {
            if (operation.type !== 'create_file')
              throw new TypeError('Invalid editor operation');
            return editor.createFile(operation);
          }),
        updateFile: (operation: ApplyPatchOperation) =>
          invoke(() => {
            if (operation.type !== 'update_file')
              throw new TypeError('Invalid editor operation');
            return editor.updateFile(operation);
          }),
        deleteFile: (operation: ApplyPatchOperation) =>
          invoke(() => {
            if (operation.type !== 'delete_file')
              throw new TypeError('Invalid editor operation');
            return editor.deleteFile(operation);
          }),
      });
    },
  });
}
