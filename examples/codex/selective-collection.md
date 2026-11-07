# Read selected documents from a collection

The application supplies an authorized catalog of opaque IDs and titles. The Agent searches that metadata and selects the IDs it needs. The application fetches and stages only those bodies, then returns bounded text pages through the existing [SelectedDocuments reader](document-workspace.ts). Collection credentials, backend paths, and scratch paths stay in application code.

This is an example recipe, not a new SDK API or search service. It uses two native function tools and an ordinary title scan.

## Run the native example

Use the matching SDK and native runtime from the [source build guide](guides/building.md). From the checkout root, run:

```sh
pnpm exec tsx examples/codex/selective-collection.ts
```

The [local fixture](selective-collection-fixture.ts) creates 10,000 decoded text files before starting the workflow timer. A native Agent uses scripted Responses to search for Orchid reports, read two reports across page boundaries, and return their total of 42 million. The example verifies the submitted tool outputs and final answer. It prints actual staged file and byte counts, selected IDs, staging times, and workflow time. It needs no model credentials. Scripted responses test the composition; they do not establish live model selection or answer quality.

## Connect application data

Import [SelectiveCollection and collectionAgent](selective-collection.ts) into server-side application code:

```ts
import { NativeProvider } from '@openai/agents';
import { collectionAgent, SelectiveCollection } from './selective-collection';

await using collection = await SelectiveCollection.open({
  catalog: [{ id: 'opaque-report-id', title: 'Orchid revenue east' }],
  // Your trusted callback checks backend access and returns decoded UTF-8 bytes.
  fetch: (id, signal) => applicationFetchAuthorizedText(id, signal),
  scratchParent: applicationScratchDirectory,
});
await using provider = new NativeProvider();
const result = await collectionAgent(collection, provider).run(
  'Find the Orchid revenue report and summarize it.',
);
```

The callback returns bytes and never writes staging files. It owns backend credentials, access checks, and extraction from PDF or Office formats. Map a permission failure to `new CollectionAccessError('denied')`. Other fetch failures return `unavailable` without backend error details. Cancellation rejects the operation rather than becoming an unavailable result.

`search_collection` returns at most 20 IDs and titles with a continuation offset. IDs contain at most 128 characters; titles and search queries contain at most 256. Metadata contains no body text or backend paths. Treat titles and document text as untrusted data.

`read_collection_document` accepts an ID, offset, and revision. The first read selects that ID for staging. Unknown IDs return `denied` before fetching. A successful result contains `status: 'ok'` and the existing reader's page fields. Follow `nextOffset` with the same revision. On `stale_revision`, restart at offset 0 with revision null. No edit or document-search tools are exposed.

## Ownership and limits

One owner serializes acquisition, writes, and reads. Concurrent first reads fetch a body once. Failed or cancelled staging leaves no successful staging record. The adapter generates filenames independently of IDs and writes them under a private temporary directory. Keep that directory and its ancestors under application control.

Supply UTF-8 bodies of at most 16 MiB. Each returned page contains at most 4,096 Unicode code points. The reader still loads and hashes the entire selected file for every page. This bounds individual model outputs, not application memory, total conversation size, or the number of selected documents.

The adapter retains each body from its first successful fetch for the collection's lifetime. These bodies do not form an atomic snapshot of the backend. Later backend policy changes do not revoke retained bodies. Close the Session before closing the collection; open a fresh collection when access changes. Closing aborts and joins in-flight work before deleting scratch. Fetch callbacks must honor the signal or eventually settle; the adapter cannot force an uncooperative callback to finish. Cleanup is not crash recovery.

## Compare with bulk copying

```sh
pnpm exec tsx examples/codex/selective-collection-benchmark.ts /tmp/js-collection-benchmark.json
```

The [benchmark](selective-collection-benchmark.ts) alternates five selected and five bulk trials over the same authorized files. Its separate bulk fixture copies all 10,000 files before using the same bounded reader and native scripted workflow. Each trial checks the content-based answer and actual staging volume. The output records failures, transferred IDs, times, and median/range summaries.

Fixture creation, volume verification, and teardown sit outside the timers. Selected staging time sums fetch/write intervals within the workflow; bulk staging time covers its full copy loop. Workflow time includes native setup and disposal. Total time includes owner setup and workflow. These local warm-cache measurements describe this synthetic fixture and sequential baseline; they make no production speedup claim.

Run focused checks without model credentials:

```sh
env -u OPENAI_API_KEY OPENAI_AGENTS_NATIVE_TESTS=1 pnpm exec vitest run \
  --project @openai/agents-codex \
  packages/agents-codex/test/native/selective-collection.test.ts \
  packages/agents-codex/test/native/selective-collection-native.test.ts
```

For files already selected by your application, use [Selected documents](selected-documents.md) directly. For native commands that need existing storage, see [storage mounts](guides/storage-mounts.md).
