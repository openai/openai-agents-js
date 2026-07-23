import { SandboxProviderError } from '@openai/agents-core/sandbox';
import {
  probeSandboxPathExists,
  type SandboxPathProbeResult,
} from '@openai/agents-core/sandbox/internal';

export async function probeRemoteSandboxPathExists(args: {
  providerName: string;
  providerId: string;
  path: string;
  runCommand: (command: string) => Promise<SandboxPathProbeResult>;
}): Promise<boolean> {
  return await probeSandboxPathExists({
    path: args.path,
    runCommand: args.runCommand,
    createError: (result) => {
      const diagnostic = result.stderr?.trim() ?? '';
      const suffix = diagnostic ? `: ${diagnostic}` : '';
      return new SandboxProviderError(
        `${args.providerName} failed to check path ${args.path}${suffix}`,
        {
          provider: args.providerId,
          path: args.path,
          status: result.status,
          signal: result.signal,
          timedOut: result.timedOut,
          stdoutBytes: result.stdout?.length ?? 0,
        },
      );
    },
  });
}
