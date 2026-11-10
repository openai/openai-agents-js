import { expect, it, vi } from 'vitest';
import { Manifest } from '../../src/sandbox/manifest';
import type { SandboxSessionLike } from '../../src/sandbox/session';
import {
  cleanupSandboxSession,
  registerSandboxPreStopHook,
} from '../../src/sandbox/runtime/sessionLifecycle';

it.each(['preStop', 'runPreStopHooks', 'registered'] as const)(
  'preserves falsy %s failure before managed capture',
  async (kind) => {
    const events: string[] = [];
    const session: SandboxSessionLike = {
      state: { manifest: new Manifest() },
      stop: async () => {
        events.push('stop');
      },
      shutdown: async () => {
        events.push('shutdown');
      },
    };
    const fail = async () => {
      events.push('pre-stop');
      throw undefined;
    };
    if (kind === 'registered') registerSandboxPreStopHook(session, fail);
    else session[kind] = fail;
    const capture = vi.fn(async () => {});
    await expect(
      cleanupSandboxSession(session, undefined, capture),
    ).rejects.toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    expect(events).toEqual(['pre-stop', 'stop', 'shutdown']);
  },
);
