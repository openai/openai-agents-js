import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Environment, type LocalStorageMount } from '../../src/index';
import { environmentConfig } from '../../src/runtime/environment';

describe.skipIf(process.platform !== 'linux')(
  'local storage mount declarations',
  () => {
    let root: string;
    let cwd: string;
    let source: string;
    beforeEach(() => {
      root = realpathSync(
        mkdtempSync(join(tmpdir(), 'agents-storage-declaration-')),
      );
      cwd = join(root, 'work');
      source = join(root, 'storage');
      mkdirSync(cwd);
      mkdirSync(source);
      writeFileSync(join(source, 'marker'), 'caller-owned');
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    });
    const mount = (source: string): LocalStorageMount => ({
      source,
      destination: source,
      strategy: 'local_bind',
    });

    it('captures immutable default read-only mounts without changing caller files', () => {
      const declarations = [mount(source)];
      const environment = Environment.local({ cwd, mounts: declarations });
      declarations[0] = mount(cwd);
      expect(environment.mounts).toEqual([
        { ...mount(source), readOnly: true },
      ]);
      expect(Object.isFrozen(environment.mounts)).toBe(true);
      expect(Object.isFrozen(environment.mounts?.[0])).toBe(true);
      expect(environmentConfig(environment)).toMatchObject({
        mounts: [
          {
            source,
            destination: source,
            strategy: 'local_bind',
            read_only: true,
          },
        ],
      });
      expect(readFileSync(join(source, 'marker'), 'utf8')).toBe('caller-owned');
      expect(environmentConfig(Environment.local({ cwd }))).not.toHaveProperty(
        'mounts',
      );
    });

    it('defaults source-only mounts to same-path read-only local binds', () => {
      const environment = Environment.local({ cwd, mounts: [{ source }] });
      expect(environment.mounts).toEqual([
        { source, destination: source, strategy: 'local_bind', readOnly: true },
      ]);
      expect(environmentConfig(environment)).toMatchObject({
        mounts: [
          {
            source,
            destination: source,
            strategy: 'local_bind',
            read_only: true,
          },
        ],
      });
    });

    it.each([
      { readOnly: false },
      { provider: 's3' },
      { config: { token: 'synthetic-secret' } },
      { strategy: 'synthetic-secret' },
      { 'synthetic-secret': true },
      { destination: '/relocated' },
      { source: 'relative' },
    ])(
      'rejects unsupported shape before acquisition without reflecting values: %#',
      (extra) => {
        let failure: unknown;
        try {
          Environment.local({
            cwd,
            mounts: [{ ...mount(source), ...extra } as LocalStorageMount],
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(TypeError);
        expect(String(failure)).not.toContain('synthetic-secret');
        expect(readFileSync(join(source, 'marker'), 'utf8')).toBe(
          'caller-owned',
        );
      },
    );

    it('rejects symlinks, nonexistent sources, files and overlapping grants', () => {
      const alias = join(root, 'alias');
      symlinkSync(source, alias);
      const child = join(source, 'child');
      mkdirSync(child);
      for (const path of [
        alias,
        join(root, 'missing'),
        join(source, 'marker'),
        cwd,
        root,
      ])
        expect(() => Environment.local({ cwd, mounts: [mount(path)] })).toThrow(
          TypeError,
        );
      expect(() =>
        Environment.local({ cwd, mounts: [mount(source), mount(child)] }),
      ).toThrow(TypeError);
      expect(() =>
        Environment.local({ cwd, mounts: [mount(source), mount(source)] }),
      ).toThrow(TypeError);
      expect(() =>
        Environment.local({
          cwd,
          writableRoots: [child],
          mounts: [mount(source)],
        }),
      ).toThrow(TypeError);
      expect(() =>
        Environment.local({ cwd: source, mounts: [mount(source)] }),
      ).toThrow(TypeError);
    });

    it('rejects remote and non-Linux mount declarations', () => {
      expect(
        () =>
          new Environment({
            url: 'wss://executor.invalid',
            cwd,
            mounts: [mount(source)],
          } as never),
      ).toThrow('Environment.local');
      vi.stubGlobal('process', { ...process, platform: 'darwin' });
      expect(() => Environment.local({ cwd, mounts: [mount(source)] })).toThrow(
        TypeError,
      );
    });
  },
);
