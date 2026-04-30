import { describe, expect, it } from 'vitest';
import {
  resolveFallbackShellCommand,
  resolveLocalShellCommand,
} from '../../src/sandbox/sandboxes/shared/shellCommand';

describe('sandbox shell command resolution', () => {
  it('uses a bash fallback for local login shells when no shell is configured', () => {
    expect(
      resolveLocalShellCommand({
        login: true,
        bashPaths: [process.execPath],
      }),
    ).toEqual({
      shellPath: process.execPath,
      flag: '-lc',
    });
  });

  it('avoids /bin/sh login mode when no local fallback shell supports it', () => {
    expect(
      resolveLocalShellCommand({
        login: true,
        bashPaths: ['/openai-agents-missing-bash'],
      }),
    ).toEqual({
      shellPath: '/bin/sh',
      flag: '-c',
    });
  });

  it('honors explicitly configured shells and login settings', () => {
    expect(
      resolveLocalShellCommand({
        shell: '/bin/sh',
        login: true,
        bashPaths: [process.execPath],
      }),
    ).toEqual({
      shellPath: '/bin/sh',
      flag: '-lc',
    });
    expect(
      resolveLocalShellCommand({
        envShell: '/usr/bin/zsh',
        login: false,
      }),
    ).toEqual({
      shellPath: '/usr/bin/zsh',
      flag: '-c',
    });
  });

  it('disables login mode for portable fallback shells', () => {
    expect(
      resolveFallbackShellCommand({
        login: true,
      }),
    ).toEqual({
      shellPath: '/bin/sh',
      flag: '-c',
    });
    expect(
      resolveFallbackShellCommand({
        shell: '/bin/bash',
        login: true,
      }),
    ).toEqual({
      shellPath: '/bin/bash',
      flag: '-lc',
    });
  });
});
