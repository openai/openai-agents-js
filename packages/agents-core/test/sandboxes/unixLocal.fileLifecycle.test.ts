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
  InMemoryRemoteSnapshotStore,
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';
import { serializeSandboxRuntimeState } from '../../src/sandbox/runtime/sessionSerialization';
import * as snapshots from '../../src/sandbox/sandboxes/shared/localSnapshots';
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

    it.each(['archive', 'local snapshot'] as const)(
      'keeps pending replacement files out of the %s',
      async (kind) => {
        const workspace = session.state.workspaceRootPath;
        await writeFile(join(workspace, 'note.txt'), 'before\n');
        const spawn = childProcess.spawn;
        let finishUpdate: (() => void) | undefined;
        vi.spyOn(childProcess, 'spawn').mockImplementation(((
          command: string,
          args: string[],
          options: childProcess.SpawnOptions,
        ) => {
          const child = spawn(command, args, options);
          if (args.includes(UNIX_LOCAL_FILE_WORKER)) {
            const stdin = child.stdin!;
            const end = stdin.end.bind(stdin);
            vi.spyOn(stdin, 'end').mockImplementation(((chunk: string) => {
              stdin.write(chunk);
              finishUpdate = () => end();
              return stdin;
            }) as typeof stdin.end);
          }
          return child;
        }) as typeof childProcess.spawn);

        const update = session.createEditor().updateFile({
          type: 'update_file',
          path: 'note.txt',
          diff: '@@\n-before\n+after\n',
        });
        try {
          await expect
            .poll(async () =>
              (await readdir(workspace)).some((name) =>
                name.startsWith('.openai-agents-'),
              ),
            )
            .toBe(true);
          const paths =
            kind === 'archive'
              ? session.persistWorkspace().then((bytes) => {
                  const archive = JSON.parse(Buffer.from(bytes).toString());
                  return [
                    ...archive.directories,
                    ...archive.files.map((file: { path: string }) => file.path),
                  ] as string[];
                })
              : new UnixLocalSandboxClient({
                  snapshot: { type: 'local', baseDir: join(root, 'snapshots') },
                })
                  .serializeSessionState(session.state)
                  .then((state) =>
                    readdir((state.snapshot as { path: string }).path, {
                      recursive: true,
                    }),
                  );
          // Give persistence time to reach the blocked replacement before release.
          await Promise.race([
            paths,
            new Promise((resolve) => setTimeout(resolve, 100)),
          ]);
          finishUpdate!();
          finishUpdate = undefined;
          await update;
          expect(
            (await paths).some((path) => path.includes('.openai-agents-')),
          ).toBe(false);
        } finally {
          finishUpdate?.();
          await update;
        }
      },
    );

    it('finishes workspace capture before starting a new file edit', async () => {
      const workspace = session.state.workspaceRootPath;
      await writeFile(join(workspace, 'note.txt'), 'before\n');
      let entered!: () => void;
      const capturing = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const capture = snapshots.createWorkspaceArchive;
      vi.spyOn(snapshots, 'createWorkspaceArchive').mockImplementationOnce(
        async (...args) => {
          entered();
          await released;
          return capture(...args);
        },
      );
      const pending = session.persistWorkspace();
      await capturing;
      const update = session.createEditor().updateFile({
        type: 'update_file',
        path: 'note.txt',
        diff: '@@\n-before\n+after\n',
      });
      const editedDuringCapture = await Promise.race([
        update.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100),
        ),
      ]);
      release();

      const archive = JSON.parse(Buffer.from(await pending).toString());
      await update;
      expect(editedDuringCapture).toBe(false);
      expect(archive.files).toEqual([
        { path: 'note.txt', data: Buffer.from('before\n').toString('base64') },
      ]);
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'after\n',
      );
    });

    it('allows a snapshot store callback to edit files during runtime serialization', async () => {
      const workspace = session.state.workspaceRootPath;
      await writeFile(join(workspace, 'note.txt'), 'before\n');
      const store = new InMemoryRemoteSnapshotStore();
      const save = store.save.bind(store);
      vi.spyOn(store, 'save').mockImplementation(async (args) => {
        await session.createEditor().updateFile({
          type: 'update_file',
          path: 'note.txt',
          diff: '@@\n-before\n+after\n',
        });
        return save(args);
      });
      const client = new UnixLocalSandboxClient({
        snapshot: { type: 'remote', id: 'saved', store },
      });

      await serializeSandboxRuntimeState({
        client,
        sandboxState: undefined,
        sessionsByAgentKey: new Map([['test', session]]),
        sessionAgentNamesByKey: new Map([['test', 'test']]),
        ownedSessionAgentKeys: new Set(),
      });

      const saved = JSON.parse(
        Buffer.from((await store.load({ id: 'saved' })).data).toString(),
      );
      expect(saved.files).toEqual([
        { path: 'note.txt', data: Buffer.from('before\n').toString('base64') },
      ]);
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'after\n',
      );
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
