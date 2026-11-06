# Read and revise selected documents

Give an Agent access to a specific set of text files by assigning each file an alias. The application chooses the trusted root, paths, and writable aliases. The model uses those aliases in its tool calls.

## Run the example

[Build the SDK and native runtime](guides/building.md) and configure your model credentials. Run the command from the checkout root.

```sh
pnpm exec tsx examples/codex/selected-documents.ts
```

The [example](selected-documents.ts) creates a temporary UTF-8 document, exposes it as `notes`, and asks the Agent to revise its status. It prints the response and the status line read back from disk, then removes the temporary directory. Set `OPENAI_BASE_URL` if your provider uses a different Responses endpoint.

## Select files and connect tools

Import `runSelectedDocuments` and pass the options for [`SelectedDocuments.open()`](document-workspace.ts), a task, and optional `NativeProviderOptions`. The runner attaches the document tools to its Agent and disposes its provider after the run.

| Tool | What it returns or changes |
| --- | --- |
| `read_document` | Up to 4,096 Unicode code points, the content revision, and the next offset. |
| `search_document` | Up to 16 matches of up to 128 code points each. Continue with the same revision and next offset to find phrases across page boundaries. |
| `revise_document` | Replaces one unique occurrence in a writable document. Supply the current revision and up to one page each of old and new text. The helper saves and reopens the file before reporting success. |

## Continue reads and handle conflicts

Follow the returned offset and revision to read another page. If the revision changes, start a fresh read. A stale tool edit returns a failed `ToolOutput` so the model can read again. Direct application methods reject a stale revision and let the caller decide how to recover. Unexpected filesystem errors reject the run.

The page limits bound the text returned by one tool call. Previous results can remain in model context, and the serialized JSON adds overhead.

## File and concurrency limits

Supply decoded UTF-8 files up to 16 MiB each. The helper reads each selected file into application memory. Extract text from binary formats such as PDF, Word, or Excel before selecting it. The helper rejects unknown aliases, disallowed writes, and selected paths that become symlinks.

The helper serializes its own edits. Use a shared lock if another process also writes the files. The [native research tests](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents-codex/test/native/retained-research.test.ts) exercise Unicode pagination, a search across a page boundary, revision checks, and an unselected file that stays outside the tool's access.
