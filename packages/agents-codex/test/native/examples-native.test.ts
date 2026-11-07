import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PAGE_CHARS,
  SelectedDocuments,
} from '../../../../examples/codex/document-workspace';
import { invokeFunctionTool } from '../../src/runtime/tools';
import type { JsonObject } from '../../src/runtime/binding';

function invokeDocumentTool(
  documents: SelectedDocuments,
  name: string,
  arguments_: JsonObject,
) {
  const declared = documents.tools().find((tool) => tool.name === name);
  if (!declared) throw new Error('Missing document tool');
  return invokeFunctionTool(
    declared,
    arguments_,
    {
      context: undefined,
      submission: {
        sessionId: 'session',
        childId: 'child',
        instanceId: '1',
        turnId: 'turn',
        submissionId: 'submission',
      },
      threadId: 'session',
      turnId: 'turn',
      callId: 'call',
      signal: new AbortController().signal,
    },
    () => {},
  );
}

describe('application-owned native examples', () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });
  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'agents-native-example-'));
    directories.push(root);
    const codex_home = join(root, 'home');
    const cwd = join(root, 'work');
    await Promise.all([mkdir(codex_home), mkdir(cwd)]);
    return {
      codex_home,
      cwd,
      strict_config: true,
      loader: {
        managed_config_path: join(root, 'managed.toml'),
        system_config_path: join(root, 'system.toml'),
        system_requirements_path: join(root, 'requirements.toml'),
        ignore_user_config: true,
        ignore_project_config: true,
      },
    };
  }

  it('bounds decoded pages, carries search continuation and serializes revision writes', async () => {
    const { cwd } = await workspace();
    const text =
      '😀'.repeat(PAGE_CHARS - 3) +
      'boundary-needle ' +
      'later '.repeat(20000) +
      'unique edit';
    await writeFile(join(cwd, 'decoded.txt'), text);
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'decoded.txt' },
      writable: ['report'],
    });
    const page = await documents.read('report');
    expect(Array.from(page.text)).toHaveLength(PAGE_CHARS);
    expect(page.nextOffset).toBe(PAGE_CHARS);
    const first = await documents.search('report', 'boundary-needle');
    expect(first.matches).toEqual([]);
    expect(first.nextOffset).not.toBeNull();
    const found = await documents.search(
      'report',
      'boundary-needle',
      first.nextOffset!,
      first.revision,
    );
    expect(found.matches[0].offset).toBe(PAGE_CHARS - 3);
    expect(Array.from(found.matches[0].text).length).toBeLessThanOrEqual(128);
    const writes = await Promise.allSettled([
      documents.revise(
        'report',
        page.revision,
        'unique edit',
        'verified artifact',
      ),
      documents.revise(
        'report',
        page.revision,
        'unique edit',
        'stale artifact',
      ),
    ]);
    expect(writes.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(await readFile(join(cwd, 'decoded.txt'), 'utf8')).toBe(
      text.replace('unique edit', 'verified artifact'),
    );
    await expect(
      documents.read('report', PAGE_CHARS, page.revision),
    ).rejects.toThrow('Stale revision');
    expect(() =>
      documents.revise(
        'report',
        page.revision,
        'x',
        'x'.repeat(PAGE_CHARS + 1),
      ),
    ).toThrow('one page');
  });

  it('keeps selected-file authority after aliases or paths are changed', async () => {
    const { cwd, codex_home: root } = await workspace();
    await writeFile(join(cwd, 'selected.txt'), 'selected');
    await writeFile(join(root, 'outside.txt'), 'outside');
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'selected.txt' },
    });
    await expect(documents.read('../outside.txt')).rejects.toThrow(
      'did not select',
    );
    expect(() =>
      documents.revise('report', 'unknown', 'selected', 'bad'),
    ).toThrow('for writing');
    await unlink(join(cwd, 'selected.txt'));
    await symlink(join(root, 'outside.txt'), join(cwd, 'selected.txt'));
    await expect(documents.read('report')).rejects.toThrow('selected path');
    expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('preserves the UTF-8 BOM and unrelated bytes when revising a document', async () => {
    const { cwd } = await workspace();
    const path = join(cwd, 'selected.txt');
    const original = '\ufeffStatus: draft\r\n🌿 Keep this line.\r\n';
    await writeFile(path, original);
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'selected.txt' },
      writable: ['report'],
    });
    const page = await documents.read('report');
    await documents.revise('report', page.revision, 'draft', 'reviewed');
    expect(await readFile(path)).toEqual(
      Buffer.from(original.replace('draft', 'reviewed'), 'utf8'),
    );
  });

  it('continues dense searches without losing or repeating matches', async () => {
    const { cwd } = await workspace();
    const phrase = '🌿 needle ';
    await writeFile(join(cwd, 'selected.txt'), phrase.repeat(38));
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'selected.txt' },
    });
    const offsets: number[] = [];
    let offset: number | null = 0;
    let revision: string | undefined;
    const counts: number[] = [];
    // Three calls suffice for 38 matches with a 16-match response limit.
    for (let page = 0; page < 3 && offset !== null; page++) {
      const result = await documents.search(
        'report',
        'needle',
        offset,
        revision,
      );
      revision = result.revision;
      counts.push(result.matches.length);
      for (const match of result.matches) {
        expect(Array.from(match.text).length).toBeLessThanOrEqual(128);
        offsets.push(match.offset);
      }
      offset = result.nextOffset;
    }
    expect(counts).toEqual([16, 16, 6]);
    expect(offset).toBeNull();
    // The emoji counts as one code point; each phrase occupies nine positions.
    expect(offsets).toEqual(
      Array.from({ length: 38 }, (_, index) => index * 9 + 2),
    );
  });

  it('rejects files outside the selected root and invalid text inputs', async () => {
    const { cwd, codex_home } = await workspace();
    const outside = join(codex_home, 'outside.txt');
    await writeFile(outside, 'Keep this file unchanged.');
    await writeFile(join(cwd, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
    await writeFile(join(cwd, 'oversized.txt'), '');
    await truncate(join(cwd, 'oversized.txt'), 16 * 1024 * 1024 + 1);
    await mkdir(join(cwd, 'directory'));
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: {
        outside,
        relativeOutside: relative(cwd, outside),
        invalid: 'invalid.txt',
        oversized: 'oversized.txt',
        directory: 'directory',
      },
    });
    await expect(documents.read('outside')).rejects.toThrow('selected path');
    await expect(documents.read('relativeOutside')).rejects.toThrow(
      'selected path',
    );
    await expect(documents.read('invalid')).rejects.toThrow();
    await expect(documents.read('oversized')).rejects.toThrow('16 MiB');
    await expect(documents.read('directory')).rejects.toThrow(
      'regular text file',
    );
    expect(await readFile(outside, 'utf8')).toBe('Keep this file unchanged.');
  });

  it('rejects ambiguous edits without changing the file or blocking a later edit', async () => {
    const { cwd } = await workspace();
    const path = join(cwd, 'selected.txt');
    await writeFile(path, 'Draft: repeat repeat.');
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'selected.txt' },
      writable: ['report'],
    });
    const page = await documents.read('report');
    await expect(
      documents.revise('report', page.revision, 'repeat', 'replacement'),
    ).rejects.toThrow('exactly once');
    expect(await readFile(path, 'utf8')).toBe('Draft: repeat repeat.');
    await documents.revise('report', page.revision, 'Draft:', 'Reviewed:');
    expect(await readFile(path, 'utf8')).toBe('Reviewed: repeat repeat.');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a selected FIFO without waiting for a writer',
    async () => {
      const { cwd } = await workspace();
      const path = join(cwd, 'selected.pipe');
      execFileSync('mkfifo', [path], { stdio: 'pipe' });
      const documents = await SelectedDocuments.open({
        root: cwd,
        selected: { pipe: 'selected.pipe' },
      });
      const read = documents.read('pipe');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          read.then(
            () => 'unexpected success',
            (error: Error) => error.message,
          ),
          new Promise<string>((resolve) => {
            timer = setTimeout(
              () => resolve('blocked waiting for a writer'),
              1000,
            );
          }),
        ]);
        expect(outcome).toBe('Select a regular text file of at most 16 MiB');
      } finally {
        clearTimeout(timer);
        // Release a regressed blocking open so it cannot leave a worker hanging.
        await open(path, constants.O_WRONLY | constants.O_NONBLOCK).then(
          (writer) => writer.close(),
          (error: NodeJS.ErrnoException) => expect(error.code).toBe('ENXIO'),
        );
        await read.catch(() => undefined);
      }
    },
  );

  it.each(['read_document', 'search_document', 'revise_document'])(
    'returns a stale revision through %s, then permits a fresh read and edit',
    async (name) => {
      const { cwd } = await workspace();
      const path = join(cwd, 'selected.txt');
      await writeFile(path, 'Original notes.');
      const documents = await SelectedDocuments.open({
        root: cwd,
        selected: { report: 'selected.txt' },
        writable: ['report'],
      });
      const first = await documents.read('report');
      // Preserve a completed edit when a later call still uses the old revision.
      await documents.revise('report', first.revision, 'Original', 'Current');
      const args = {
        document: 'report',
        revision: first.revision,
        ...(name === 'revise_document'
          ? { oldText: 'notes', newText: 'stale edit' }
          : {
              offset: 0,
              ...(name === 'search_document' ? { query: 'notes' } : {}),
            }),
      };
      const conflict = await invokeDocumentTool(documents, name, args);
      expect(conflict).toEqual({
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: expect.stringContaining('offset 0 and revision null'),
          },
        ],
      });
      expect(await readFile(path, 'utf8')).toBe('Current notes.');
      const fresh = await invokeDocumentTool(documents, 'read_document', {
        document: 'report',
        revision: null,
        offset: 0,
      });
      expect(fresh.success).toBe(true);
      const content = fresh.contentItems[0];
      if (content.type !== 'inputText')
        throw new Error('Expected document JSON');
      const page = JSON.parse(content.text);
      expect(page.text).toBe('Current notes.');
      const edited = await invokeDocumentTool(documents, 'revise_document', {
        document: 'report',
        revision: page.revision,
        oldText: 'notes',
        newText: 'reviewed notes',
      });
      expect(edited.success).toBe(true);
      expect(await readFile(path, 'utf8')).toBe('Current reviewed notes.');
    },
  );

  it('does not turn an unexpected filesystem failure into a revision retry', async () => {
    const { cwd } = await workspace();
    const path = join(cwd, 'selected.txt');
    await writeFile(path, 'Notes.');
    const documents = await SelectedDocuments.open({
      root: cwd,
      selected: { report: 'selected.txt' },
    });
    await unlink(path);
    await expect(
      invokeDocumentTool(documents, 'read_document', {
        document: 'report',
        revision: null,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
