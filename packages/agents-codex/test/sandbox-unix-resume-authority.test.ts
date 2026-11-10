import { describe, expect, it, vi } from 'vitest';
import { Manifest } from '@openai/agents-core/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { Environment, sandboxEnvironment } from '../src';
import { acquireEnvironment } from '../src/runtime/environment-source';

describe('native live UnixLocal resume authority', () => {
  it.each(['direct', 'native', 'unregistered'] as const)(
    '%s state capture',
    async (mode) => {
      const client = new UnixLocalSandboxClient();
      const original = await client.create(new Manifest());
      const connect = vi.fn(async () =>
        Environment.lease(
          new Environment({
            url: 'wss://fixture.invalid',
            cwd: original.state.manifest.root,
          }),
          async () => {},
        ),
      );
      try {
        if (mode === 'direct') {
          const resumed = await client.resume(original.state);
          await resumed.close();
          return;
        }
        const state =
          mode === 'unregistered' ? { ...original.state } : original.state;
        const source = sandboxEnvironment({
          client,
          manifest: original.state.manifest,
          authorizedResumeState: { backendId: client.backendId, state },
          connect,
        });
        if (mode === 'unregistered') {
          await expect(acquireEnvironment(source)).rejects.toThrow(
            'trusted resumeAuthority host paths',
          );
          expect(connect).not.toHaveBeenCalled();
        } else {
          const owner = await acquireEnvironment(source);
          expect(connect).toHaveBeenCalledOnce();
          await owner.dispose();
        }
      } finally {
        await original.close();
        await original.delete();
      }
    },
  );
});
