import { constants } from 'node:fs';
import { open, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { tool, ToolOutput } from '@openai/agents';

export const PAGE_CHARS = 4096;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const offsetSchema = z.number().int().nonnegative();

class RevisionConflict extends Error {}

/** Return expected conflicts to the model; unexpected filesystem errors reject. */
async function withRevisionRecovery<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof RevisionConflict)) throw error;
    return new ToolOutput(
      [
        {
          type: 'inputText',
          text: 'The document changed. Restart with read_document at offset 0 and revision null, then use the returned revision for later reads or edits.',
        },
      ],
      false,
    );
  }
}

/** Application-selected UTF-8 text, including text the application extracted from a PDF. */
export class SelectedDocuments {
  private serial: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly root: string,
    private readonly selected: ReadonlyMap<string, string>,
    private readonly writable: ReadonlySet<string>,
  ) {}

  static async open(options: {
    root: string;
    selected: Record<string, string>;
    writable?: readonly string[];
  }): Promise<SelectedDocuments> {
    const selected = new Map(Object.entries(options.selected));
    const writable = new Set(options.writable);
    if ([...writable].some((alias) => !selected.has(alias)))
      throw new Error('Writable documents must be selected by the application');
    return new SelectedDocuments(
      await realpath(options.root),
      selected,
      writable,
    );
  }

  private async load(alias: string) {
    const name = this.selected.get(alias);
    if (name === undefined)
      throw new Error('The application did not select this document');
    const path = resolve(this.root, name);
    const within = relative(this.root, path);
    if (
      !within ||
      within === '..' ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within) ||
      (await realpath(path)) !== path
    )
      throw new Error('Selected document must remain at its selected path');
    // A selected FIFO must reach the regular-file check without waiting for a writer.
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new Error('Select a regular text file of at most 16 MiB');
      const bytes = await file.readFile();
      if (bytes.length > MAX_FILE_BYTES)
        throw new Error('Selected document grew beyond 16 MiB');
      const text = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      return {
        path,
        text,
        mode: stat.mode & 0o777,
        revision: createHash('sha256').update(bytes).digest('hex'),
      };
    } finally {
      await file.close();
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => undefined);
    return result;
  }

  read(alias: string, offset = 0, expectedRevision?: string) {
    offsetSchema.parse(offset);
    return this.exclusive(async () => {
      const document = await this.load(alias);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== document.revision
      )
        throw new RevisionConflict('Stale revision; restart the read');
      const characters = Array.from(document.text);
      const text = characters.slice(offset, offset + PAGE_CHARS).join('');
      return {
        document: alias,
        revision: document.revision,
        offset,
        text,
        nextOffset:
          offset + PAGE_CHARS < characters.length ? offset + PAGE_CHARS : null,
      };
    });
  }

  async search(
    alias: string,
    query: string,
    offset = 0,
    expectedRevision?: string,
  ) {
    const needle = Array.from(query);
    if (needle.length < 1 || needle.length > 256)
      throw new Error('Search text must contain 1 to 256 characters');
    const page = await this.read(alias, offset, expectedRevision);
    const characters = Array.from(page.text);
    const matches: { offset: number; text: string }[] = [];
    let cursor = 0;
    while (cursor <= characters.length - needle.length && matches.length < 16) {
      if (
        needle.every(
          (character, index) => characters[cursor + index] === character,
        )
      ) {
        matches.push({
          offset: offset + cursor,
          text: characters.slice(cursor, cursor + 128).join(''),
        });
        cursor += needle.length;
      } else cursor++;
    }
    return {
      document: alias,
      revision: page.revision,
      matches,
      nextOffset:
        matches.length === 16
          ? offset + cursor
          : page.nextOffset === null
            ? null
            : offset + characters.length - needle.length + 1,
    };
  }

  revise(
    alias: string,
    expectedRevision: string,
    oldText: string,
    newText: string,
  ) {
    if (!this.writable.has(alias))
      throw new Error(
        'The application did not select this document for writing',
      );
    if (
      !oldText ||
      Array.from(oldText).length > PAGE_CHARS ||
      Array.from(newText).length > PAGE_CHARS
    )
      throw new Error('Select one nonempty edit of at most one page');
    return this.exclusive(async () => {
      const before = await this.load(alias);
      if (before.revision !== expectedRevision)
        throw new RevisionConflict('Stale revision; read before editing');
      const first = before.text.indexOf(oldText);
      if (first < 0 || before.text.indexOf(oldText, first + 1) >= 0)
        throw new Error('Edit text must occur exactly once');
      const after =
        before.text.slice(0, first) +
        newText +
        before.text.slice(first + oldText.length);
      if (Buffer.byteLength(after) > MAX_FILE_BYTES)
        throw new Error('Edited document exceeds 16 MiB');
      const temporary = resolve(
        dirname(before.path),
        `.agents-document-${randomUUID()}`,
      );
      try {
        const file = await open(temporary, 'wx', before.mode);
        try {
          await file.writeFile(after, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        // This owner serializes its edits. External writers must use their own shared lock.
        const current = await this.load(alias);
        if (current.revision !== before.revision)
          throw new RevisionConflict('Document changed before the write');
        await rename(temporary, before.path);
        const saved = await this.load(alias);
        if (saved.text !== after)
          throw new Error('Artifact verification failed');
        return {
          document: alias,
          revision: saved.revision,
          status: 'saved and reopened',
        };
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  tools() {
    const page = {
      document: z.string(),
      offset: offsetSchema,
      revision: z.string().nullable(),
    };
    return [
      tool({
        name: 'read_document',
        description:
          'Read a selected text page. Follow nextOffset with the same revision.',
        parameters: z.object(page),
        execute: ({ document, offset, revision }) =>
          withRevisionRecovery(() =>
            this.read(document, offset, revision ?? undefined),
          ),
      }),
      tool({
        name: 'search_document',
        description:
          'Search one selected text page. Follow nextOffset until null.',
        parameters: z.object({ ...page, query: z.string() }),
        execute: ({ document, query, offset, revision }) =>
          withRevisionRecovery(() =>
            this.search(document, query, offset, revision ?? undefined),
          ),
      }),
      tool({
        name: 'revise_document',
        description:
          'Replace unique text in a writable document using a recent revision.',
        parameters: z.object({
          document: z.string(),
          revision: z.string(),
          oldText: z.string(),
          newText: z.string(),
        }),
        execute: ({ document, revision, oldText, newText }) =>
          withRevisionRecovery(() =>
            this.revise(document, revision, oldText, newText),
          ),
      }),
    ];
  }
}
