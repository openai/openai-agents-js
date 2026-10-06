import * as childProcess from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';
import { UNIX_LOCAL_FILE_WORKER } from '../../src/sandbox/sandboxes/shared/unixLocalFileWorker';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

describe.skipIf(process.platform === 'win32')(
  'UnixLocal file operation cancellation',
  () => {
    let root: string;
    let grant: string;
    let session: UnixLocalSandboxSession;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'unix-local-file-lifecycle-'));
      grant = join(root, 'grant');
      await mkdir(grant);
      await writeFile(join(grant, 'note.txt'), 'before\n');
      session = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
      }).create(
        new Manifest({
          extraPathGrants: [{ path: grant, readOnly: false }],
        }),
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await session.close();
      await rm(root, { recursive: true, force: true });
    });

    it.each(['stop', 'close'] as const)(
      'cleans a blocked replacement in a writable grant when %s completes',
      async (operation) => {
        const spawn = childProcess.spawn;
        vi.spyOn(childProcess, 'spawn').mockImplementation(((
          command: string,
          args: string[],
          options: childProcess.SpawnOptions,
        ) => {
          const child = spawn(command, args, options);
          if (args.includes(UNIX_LOCAL_FILE_WORKER)) {
            // Deliver the real update but withhold EOF so the trusted worker waits
            // on its input pipe after opening the staged replacement.
            const stdin = child.stdin!;
            vi.spyOn(stdin, 'end').mockImplementation(((chunk: string) => {
              stdin.write(chunk);
              return stdin;
            }) as typeof stdin.end);
          }
          return child;
        }) as typeof childProcess.spawn);

        const pending = session.createEditor().updateFile({
          type: 'update_file',
          path: join(grant, 'note.txt'),
          diff: '@@\n-before\n+after\n',
        });
        const rejected = expect(pending).rejects.toThrow(/cancelled/);

        await expect
          .poll(async () => {
            const stages = (await readdir(grant)).filter((name) =>
              name.startsWith('.openai-agents-'),
            );
            if (stages.length !== 1) return false;
            return (await readdir(join(grant, stages[0]!))).includes('content');
          })
          .toBe(true);
        expect(await readFile(join(grant, 'note.txt'), 'utf8')).toBe(
          'before\n',
        );

        await Promise.all([session[operation](), session[operation]()]);
        await rejected;
        expect(await readdir(grant)).toEqual(['note.txt']);
        expect(await readFile(join(grant, 'note.txt'), 'utf8')).toBe(
          'before\n',
        );
      },
    );
  },
);
