import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Environment } from '../src/index';
import { environmentConfig } from '../src/runtime/environment';

const cwd = '/workspace';
const source = '/application/skills';

afterEach(() => vi.unstubAllGlobals());

describe('macOS local read-only roots declarations', () => {
  it('keeps the default wire settings for omitted and empty roots', () => {
    const defaults = environmentConfig(Environment.local({ cwd }));
    expect(defaults).not.toHaveProperty('read_only_roots');
    expect(
      environmentConfig(Environment.local({ cwd, readOnlyRoots: [] })),
    ).toEqual(defaults);
  });

  it('captures absolute paths and file URIs independently of caller mutation', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const roots = [source, pathToFileURL('/application/docs').href];
    const environment = Environment.local({ cwd, readOnlyRoots: roots });
    roots[0] = cwd;
    const captured = [pathToFileURL(source).href, roots[1]];
    expect(environment.readOnlyRoots).toEqual(captured);
    expect(Object.isFrozen(environment.readOnlyRoots)).toBe(true);
    expect(environmentConfig(environment)).toHaveProperty(
      'read_only_roots',
      captured,
    );
  });

  it('rejects nonempty Linux local and macOS remote declarations', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(() => Environment.local({ cwd, readOnlyRoots: [source] })).toThrow(
      /readOnlyRoots requires Environment.local on macOS/,
    );
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(
      () =>
        new Environment({
          url: 'wss://executor.invalid',
          cwd,
          readOnlyRoots: [source] as never,
        }),
    ).toThrow(/readOnlyRoots requires Environment.local on macOS/);
  });

  it('rejects malformed declarations without reflecting values', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    for (const roots of [
      ['synthetic-relative'],
      ['file:///application/skills?synthetic-query'],
      { root: 'synthetic-object' },
    ]) {
      expect(() =>
        Environment.local({ cwd, readOnlyRoots: roots as string[] }),
      ).toThrow(/^readOnlyRoots must contain absolute paths or file URIs$/);
    }
  });
});
