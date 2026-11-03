import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent, NativeProvider } from '@openai/agents';
import {
  PAGE_CHARS,
  SelectedDocuments,
} from '../../examples/document-workspace';
import { runSelectedDocuments } from '../../examples/selected-documents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const homes: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function toolResult(request: JsonObject, callId: string): JsonObject {
  const result = (request.input as JsonObject[]).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(result, `Missing tool result: ${callId}`).toBeDefined();
  const output = result!.output;
  const text =
    typeof output === 'string'
      ? output
      : (output as JsonObject[]).map((part) => part.text ?? '').join('');
  return JSON.parse(text) as JsonObject;
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'retained research and revision workflow',
  () => {
    it('reads Unicode pages and continues a boundary search through the document entrypoint', async () => {
      const home = await mkdtemp(join(tmpdir(), 'selected-document-pages-'));
      homes.push(home);
      const query = 'boundary-needle';
      const source =
        '😀'.repeat(PAGE_CHARS - 3) +
        query +
        '🌿'.repeat(PAGE_CHARS + 17) +
        '\nlast-page-sentinel';
      const unselected = query + ' decoy content must not reach the model';
      await Promise.all([
        writeFile(join(home, 'decoded.txt'), source),
        writeFile(join(home, 'unselected.txt'), unselected),
      ]);
      const characters = Array.from(source);
      const revision = digest(source);
      const pages: string[] = [];
      let searchOffset = 0;
      function readPage(request: JsonObject, callId: string, offset: number) {
        const page = toolResult(request, callId);
        expect(page).toEqual({
          document: 'source',
          revision,
          offset,
          text: characters.slice(offset, offset + PAGE_CHARS).join(''),
          nextOffset:
            offset + PAGE_CHARS < characters.length
              ? offset + PAGE_CHARS
              : null,
        });
        expect(Array.from(page.text as string).length).toBeLessThanOrEqual(
          PAGE_CHARS,
        );
        // Include JSON metadata in this synthetic fixture's byte bound.
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          PAGE_CHARS * 4 + 512,
        );
        pages.push(page.text as string);
        return page;
      }
      const server = new ModelServer([
        [
          call(
            'read_document',
            { document: 'source', offset: 0, revision: null },
            { callId: 'first-page' },
          ),
        ],
        (request) => {
          const page = readPage(request, 'first-page', 0);
          expect(JSON.stringify(request.input)).not.toContain(
            'last-page-sentinel',
          );
          return [
            call(
              'read_document',
              {
                document: page.document,
                offset: page.nextOffset,
                revision: page.revision,
              },
              { callId: 'second-page' },
            ),
          ];
        },
        (request) => {
          const page = readPage(request, 'second-page', PAGE_CHARS);
          expect(JSON.stringify(request.input)).not.toContain(
            'last-page-sentinel',
          );
          return [
            call(
              'read_document',
              {
                document: page.document,
                offset: page.nextOffset,
                revision: page.revision,
              },
              { callId: 'last-page' },
            ),
          ];
        },
        (request) => {
          expect(
            readPage(request, 'last-page', PAGE_CHARS * 2).nextOffset,
          ).toBe(null);
          expect(pages.join('')).toBe(source);
          return [
            call(
              'search_document',
              { document: 'source', query, offset: 0, revision },
              { callId: 'first-search' },
            ),
          ];
        },
        (request) => {
          const result = toolResult(request, 'first-search');
          searchOffset = PAGE_CHARS - Array.from(query).length + 1;
          expect(result).toEqual({
            document: 'source',
            revision,
            matches: [],
            nextOffset: searchOffset,
          });
          return [
            call(
              'search_document',
              {
                document: result.document,
                query,
                offset: result.nextOffset,
                revision: result.revision,
              },
              { callId: 'continued-search' },
            ),
          ];
        },
        (request) => {
          const result = toolResult(request, 'continued-search');
          expect(result).toEqual({
            document: 'source',
            revision,
            matches: [
              {
                offset: PAGE_CHARS - 3,
                text: characters
                  .slice(PAGE_CHARS - 3, PAGE_CHARS + 125)
                  .join(''),
              },
            ],
            nextOffset:
              searchOffset + PAGE_CHARS - Array.from(query).length + 1,
          });
          return [message('Read three pages and found the boundary phrase.')];
        },
      ]);
      const config = await server.config();
      const output = await runSelectedDocuments(
        { root: home, selected: { source: 'decoded.txt' } },
        'Read source and find boundary-needle using the document tools.',
        {
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-selected-documents',
          supportsWebsockets: false,
        },
      );
      expect(output).toBe('Read three pages and found the boundary phrase.');
      expect(await readFile(join(home, 'decoded.txt'), 'utf8')).toBe(source);
      expect(await readFile(join(home, 'unselected.txt'), 'utf8')).toBe(
        unselected,
      );
      expect(JSON.stringify(server.requests)).not.toContain('decoy content');
      server.assertExhausted();
    });

    it('saves a grounded citation and preserves it through a second user-directed revision', async () => {
      const home = await mkdtemp(join(tmpdir(), 'retained-research-'));
      homes.push(home);
      const source = '🔭 Field note\nTitan has a dense nitrogen atmosphere.\n';
      const quote = 'Titan has a dense nitrogen atmosphere.';
      const before = 'Replace this draft after reading the selected source.';
      const unselected = 'An unselected file must remain unchanged.';
      await Promise.all([
        writeFile(join(home, 'source.txt'), source),
        writeFile(join(home, 'artifact.json'), before),
        writeFile(join(home, 'unselected.txt'), unselected),
      ]);
      const documents = await SelectedDocuments.open({
        root: home,
        selected: { source: 'source.txt', artifact: 'artifact.json' },
        writable: ['artifact'],
      });
      const sourceRevision = digest(source);
      const offset = Array.from(source.slice(0, source.indexOf(quote))).length;
      // The astral character makes code-point and UTF-16 offsets differ.
      expect(offset).not.toBe(source.indexOf(quote));
      let citation: JsonObject | undefined;
      let draft = '';
      let revised = '';
      const server = new ModelServer([
        [
          call(
            'read_document',
            { document: 'source', offset: 0, revision: null },
            { callId: 'source-read' },
          ),
        ],
        (request) => {
          expect(toolResult(request, 'source-read')).toEqual({
            document: 'source',
            revision: sourceRevision,
            offset: 0,
            text: source,
            nextOffset: null,
          });
          return [
            call(
              'search_document',
              {
                document: 'source',
                query: quote,
                offset: 0,
                revision: sourceRevision,
              },
              { callId: 'source-search' },
            ),
          ];
        },
        (request) => {
          const found = toolResult(request, 'source-search');
          expect(found).toMatchObject({
            document: 'source',
            revision: sourceRevision,
            matches: [{ offset, text: quote + '\n' }],
            nextOffset: null,
          });
          const match = (found.matches as JsonObject[])[0];
          citation = {
            document: found.document,
            revision: found.revision,
            offset: match.offset,
            quote,
          };
          draft = JSON.stringify(
            { title: 'Titan', claim: quote, citation },
            null,
            2,
          );
          return [
            call(
              'read_document',
              {
                document: 'artifact',
                offset: 0,
                revision: null,
              },
              { callId: 'artifact-before' },
            ),
          ];
        },
        (request) => {
          const artifact = toolResult(request, 'artifact-before');
          expect(artifact).toMatchObject({
            text: before,
            revision: digest(before),
          });
          return [
            call(
              'revise_document',
              {
                document: 'artifact',
                revision: artifact.revision,
                oldText: before,
                newText: draft,
              },
              { callId: 'draft-save' },
            ),
          ];
        },
        (request) => {
          expect(toolResult(request, 'draft-save')).toEqual({
            document: 'artifact',
            revision: digest(draft),
            status: 'saved and reopened',
          });
          return [message('The cited draft is saved.')];
        },
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'Add a descriptive title',
          );
          return [
            call(
              'read_document',
              {
                document: 'artifact',
                offset: 0,
                revision: null,
              },
              { callId: 'artifact-draft' },
            ),
          ];
        },
        (request) => {
          const artifact = toolResult(request, 'artifact-draft');
          expect(artifact).toMatchObject({
            text: draft,
            revision: digest(draft),
          });
          const oldText = '"title": "Titan"';
          const newText = '"title": "Titan and its atmosphere"';
          revised = draft.replace(oldText, newText);
          return [
            call(
              'revise_document',
              {
                document: 'artifact',
                revision: artifact.revision,
                oldText,
                newText,
              },
              { callId: 'revision-save' },
            ),
          ];
        },
        (request) => {
          expect(toolResult(request, 'revision-save')).toEqual({
            document: 'artifact',
            revision: digest(revised),
            status: 'saved and reopened',
          });
          return [
            message('The title is revised and the citation is preserved.'),
          ];
        },
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-retained-research',
        supportsWebsockets: false,
      });
      await using session = await new Agent({
        instructions:
          'Read the selected source and save the requested cited artifact.',
        model: 'gpt-5',
        provider,
        tools: documents.tools(),
      }).session();
      await (
        await session.submit(
          'Research Titan, cite the selected source, and save a draft.',
        )
      ).wait();
      const savedDraft = await readFile(join(home, 'artifact.json'));
      expect(savedDraft.toString()).toBe(draft);
      expect(JSON.parse(savedDraft.toString()).citation).toEqual(citation);
      await (
        await session.submit(
          'Add a descriptive title to the saved artifact. Keep its citation.',
        )
      ).wait();
      const savedRevision = await readFile(join(home, 'artifact.json'));
      expect(savedRevision.toString()).toBe(revised);
      const savedCitation = JSON.parse(savedRevision.toString()).citation;
      expect(savedCitation).toEqual(citation);
      const retainedSource = await readFile(join(home, 'source.txt'));
      expect(retainedSource.toString()).toBe(source);
      expect(savedCitation.revision).toBe(digest(retainedSource));
      expect(
        Array.from(retainedSource.toString())
          .slice(
            savedCitation.offset,
            savedCitation.offset + Array.from(savedCitation.quote).length,
          )
          .join(''),
      ).toBe(savedCitation.quote);
      expect(await readFile(join(home, 'unselected.txt'), 'utf8')).toBe(
        unselected,
      );
      const revisions = [
        digest(before),
        digest(savedDraft),
        digest(savedRevision),
      ];
      expect(new Set(revisions).size).toBe(3);
      server.assertExhausted();
      const evidence = process.env.RETAINED_WORKFLOW_EVIDENCE_DIR;
      if (evidence)
        await writeFile(
          join(evidence, 'research.json'),
          JSON.stringify({ revisions, citation: savedCitation }),
          { flag: 'wx' },
        );
    });
  },
);
