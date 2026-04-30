import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  boxMount,
  dir,
  dockerVolumeMountStrategy,
  file,
  gcsMount,
  gitRepo,
  inContainerMountStrategy,
  isDir,
  isMount,
  localDir,
  localFile,
  mount,
  r2Mount,
  s3FilesMount,
  s3Mount,
  azureBlobMount,
  type BoxMount,
  type Dir,
  type Entry,
  type S3Mount,
} from '../src/sandbox';

describe('sandbox entry helpers', () => {
  it('creates manifest entries with the expected discriminators', () => {
    expect(dir()).toEqual({ type: 'dir' });
    expect(
      dir({
        children: {
          'README.md': file({ content: 'hello' }),
        },
      }),
    ).toEqual({
      type: 'dir',
      children: {
        'README.md': {
          type: 'file',
          content: 'hello',
        },
      },
    });
    expect(file({ content: 'hello', ephemeral: true })).toEqual({
      type: 'file',
      content: 'hello',
      ephemeral: true,
    });
    expect(localFile({ src: '/tmp/input.txt' })).toEqual({
      type: 'local_file',
      src: '/tmp/input.txt',
    });
    expect(localDir({ src: '/tmp/project' })).toEqual({
      type: 'local_dir',
      src: '/tmp/project',
    });
    expect(gitRepo({ repo: 'https://example.com/repo.git' })).toEqual({
      type: 'git_repo',
      repo: 'https://example.com/repo.git',
    });
    expect(
      gitRepo({ host: 'git.example.com', repo: 'org/repo', ref: 'main' }),
    ).toEqual({
      type: 'git_repo',
      host: 'git.example.com',
      repo: 'org/repo',
      ref: 'main',
    });
    expect(
      mount({
        source: 's3://bucket/data',
        mountPath: 'data',
        readOnly: true,
        mountStrategy: { type: 'in_container' },
      }),
    ).toEqual({
      type: 'mount',
      source: 's3://bucket/data',
      mountPath: 'data',
      readOnly: true,
      mountStrategy: { type: 'in_container' },
    });
  });

  it('narrows directory entries', () => {
    const entry: Entry = dir({
      children: {
        'README.md': file({ content: 'hello' }),
      },
    });

    expect(isDir(entry)).toBe(true);
    if (isDir(entry)) {
      expectTypeOf(entry).toEqualTypeOf<Dir>();
      expect(entry.children?.['README.md']).toEqual({
        type: 'file',
        content: 'hello',
      });
    }
    expect(isDir(file({ content: 'hello' }))).toBe(false);
  });

  it('narrows mount entries', () => {
    const entry: Entry = s3Mount({ bucket: 'bucket' });

    expect(isMount(entry)).toBe(true);
    if (isMount(entry)) {
      expectTypeOf(entry).toMatchTypeOf<S3Mount>();
      expect(entry.type).toBe('s3_mount');
    }
    expect(isMount(file({ content: 'hello' }))).toBe(false);
  });

  it('creates typed mounts and mount strategies', () => {
    expect(s3Mount({ bucket: 'bucket', prefix: 'data' })).toMatchObject({
      type: 's3_mount',
      bucket: 'bucket',
      prefix: 'data',
    });
    expect(gcsMount({ bucket: 'bucket' })).toMatchObject({
      type: 'gcs_mount',
      bucket: 'bucket',
    });
    expect(r2Mount({ bucket: 'bucket', accountId: 'acct' })).toMatchObject({
      type: 'r2_mount',
      bucket: 'bucket',
      accountId: 'acct',
    });
    expect(
      azureBlobMount({ container: 'container', accountName: 'acct' }),
    ).toMatchObject({
      type: 'azure_blob_mount',
      container: 'container',
      accountName: 'acct',
    });
    expect(
      boxMount({
        path: '/shared/data',
        boxSubType: 'enterprise',
      }),
    ).toMatchObject({
      type: 'box_mount',
      path: '/shared/data',
      boxSubType: 'enterprise',
    });
    expectTypeOf(boxMount()).toMatchTypeOf<BoxMount>();
    expect(s3FilesMount({ bucket: 'bucket' })).toMatchObject({
      type: 's3_files_mount',
      bucket: 'bucket',
    });
    expect(inContainerMountStrategy()).toEqual({ type: 'in_container' });
    expect(
      dockerVolumeMountStrategy({
        driver: 'local',
        driverOptions: { type: 'nfs' },
      }),
    ).toEqual({
      type: 'docker_volume',
      driver: 'local',
      driverOptions: { type: 'nfs' },
    });
    expect(
      mount({
        source: 's3://bucket/data',
        mountStrategy: inContainerMountStrategy(),
      }),
    ).toMatchObject({
      type: 'mount',
      mountStrategy: { type: 'in_container' },
    });
  });
});
