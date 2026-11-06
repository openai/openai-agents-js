import { isDeepStrictEqual } from 'node:util';
import {
  Manifest,
  normalizeSandboxClientCreateArgs,
  type ExecCommandArgs,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxClientOptions,
  type SandboxExecResult,
  type SandboxSessionLike,
} from '@openai/agents/classic/sandbox';

/** The application supplies its existing Modal Sandbox; this example never looks one up. */
export interface SelectedModalSandbox {
  exec(
    command: string[],
    options: { timeoutMs: number; stdout: 'ignore'; stderr: 'ignore' },
  ): Promise<{ wait(): Promise<number> }>;
}

function probeSession(
  selected: SelectedModalSandbox,
  disposeSelected?: () => Promise<void>,
): SandboxSessionLike {
  let used = false;
  let closing = false;
  let active: Promise<SandboxExecResult> | undefined;
  let shutdown: Promise<void> | undefined;
  const session: SandboxSessionLike = {
    state: { manifest: new Manifest() },
    supportsPty: () => false,
    async exec(args: ExecCommandArgs) {
      if (closing || used) throw new Error('This probe session is single-use.');
      if (
        args.cmd !== 'python -V' ||
        args.login !== false ||
        (args.tty !== undefined && args.tty !== false) ||
        args.workdir !== undefined ||
        args.shell !== undefined ||
        args.runAs !== undefined ||
        args.maxOutputTokens !== undefined ||
        (args.yieldTimeMs !== undefined && args.yieldTimeMs !== 10_000) ||
        Object.keys(args).some(
          (key) =>
            ![
              'cmd',
              'login',
              'tty',
              'workdir',
              'shell',
              'runAs',
              'maxOutputTokens',
              'yieldTimeMs',
            ].includes(key),
        )
      ) {
        throw new Error(
          'This example supports only the blocking Python version probe.',
        );
      }
      used = true;
      const started = performance.now();
      // Publish the admitted promise before invoking provider code, including reentrant code.
      active = Promise.resolve().then(async () => {
        const process = await selected.exec(['python', '-V'], {
          timeoutMs: 5_000,
          stdout: 'ignore',
          stderr: 'ignore',
        });
        const exitCode = await process.wait();
        if (!Number.isInteger(exitCode))
          throw new Error('Invalid probe exit code.');
        return {
          output: '',
          stdout: '',
          stderr: '',
          exitCode,
          wallTimeSeconds: (performance.now() - started) / 1000,
        };
      });
      return active;
    },
    async execCommand(args) {
      return JSON.stringify(await session.exec!(args));
    },
  };
  if (disposeSelected) {
    // Expose only one disposal method: SDK cleanup can invoke every standard method present.
    session.shutdown = () => {
      closing = true;
      return (shutdown ??= Promise.resolve().then(async () => {
        await Promise.allSettled(active ? [active] : []);
        await disposeSelected();
      }));
    };
  }
  return session;
}

/** Pass this session in sandbox.session. The application retains the selected sandbox. */
export function borrowSelectedModalProbe(
  selected: SelectedModalSandbox,
): SandboxSessionLike {
  return probeSession(selected);
}

/**
 * Pass this client in sandbox.client only when transferring disposal of the selected sandbox.
 * The callback belongs to the application, for example () => selected.terminate().
 */
export function ownSelectedModalProbe(
  selected: SelectedModalSandbox,
  disposeSelected: () => Promise<void>,
): SandboxClient {
  let bound = false;
  const session = probeSession(selected, disposeSelected);
  return {
    backendId: 'application-selected-modal-probe',
    async create(
      args?: SandboxClientCreateArgs | Manifest,
      options?: SandboxClientOptions,
    ) {
      if (
        (options !== undefined && !(args instanceof Manifest)) ||
        (args !== undefined &&
          !(args instanceof Manifest) &&
          Object.keys(args).some(
            (key) =>
              ![
                'manifest',
                'snapshot',
                'options',
                'concurrencyLimits',
                'archiveLimits',
              ].includes(key),
          ))
      ) {
        throw new Error('Unsupported probe binding configuration.');
      }
      const request = normalizeSandboxClientCreateArgs(args, options);
      if (
        bound ||
        request.snapshot !== undefined ||
        request.options !== undefined ||
        request.concurrencyLimits !== undefined ||
        request.archiveLimits !== undefined ||
        !isDeepStrictEqual(request.manifest, new Manifest())
      ) {
        throw new Error(
          'This example binds once with an empty manifest and no provisioning options.',
        );
      }
      bound = true;
      return session;
    },
  };
}
