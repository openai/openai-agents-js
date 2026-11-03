import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  type NativeProviderOptions,
} from '@openai/agents';
import { PAGE_CHARS, SelectedDocuments } from './document-workspace';

/** Run bounded document tools over files selected by the application. */
export async function runSelectedDocuments(
  options: Parameters<typeof SelectedDocuments.open>[0],
  task: string,
  providerOptions: NativeProviderOptions = {},
): Promise<string> {
  const documents = await SelectedDocuments.open(options);
  await using provider = new NativeProvider(providerOptions);
  const agent = new Agent({
    instructions:
      'Use only the document aliases selected by the application. ' +
      'Read or search only the pages needed for the task. Follow nextOffset ' +
      'with the same revision, and restart a read if its revision is stale. ' +
      'Before editing, read the writable document and use its current revision. ' +
      'For an edit, report success only after the tool confirms it was saved.',
    tools: documents.tools(),
    provider,
  });
  const result = await agent.run(task);
  return result.finalOutput;
}

async function main(): Promise<void> {
  await using directory = {
    path: await mkdtemp(join(tmpdir(), 'agents-selected-documents-')),
    async [Symbol.asyncDispose]() {
      await rm(this.path, { recursive: true, force: true });
    },
  };
  // A real application supplies decoded text, such as text extracted from a PDF.
  const path = join(directory.path, 'decoded.txt');
  await writeFile(
    path,
    'Status: draft\n' + '🌿 Field note.\n'.repeat(PAGE_CHARS),
    'utf8',
  );
  console.log(
    await runSelectedDocuments(
      {
        root: directory.path,
        selected: { notes: 'decoded.txt' },
        writable: ['notes'],
      },
      'In notes, replace the unique Status: draft with Status: reviewed. ' +
        'Keep all other text unchanged.',
      { baseUrl: process.env.OPENAI_BASE_URL },
    ),
  );
  console.log((await readFile(path, 'utf8')).split('\n')[0]);
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
