# Let a native parent combine two research findings

[parallel-research.ts](../parallel-research.ts) gives a native parent two research assignments. The parent starts two native child agents, waits for their findings, and combines them into an answer. The application observes progress and waits for each child Turn.

The two embedded synthetic excerpts describe cobalt roofs reducing summer heat and shaded courtyards retaining cool air. They are trusted application inputs, not fetched research or real study claims.

## Run from a built checkout

Configure these values before running the command:

| Environment variable | Meaning |
| --- | --- |
| `OPENAI_MODEL` | Required explicit model compatible with native children. |
| `OPENAI_API_KEY` | Required model-provider key. |
| `OPENAI_BASE_URL` | Optional compatible Responses endpoint, passed explicitly to NativeProvider. Omission uses the SDK default endpoint. |
| `RESEARCH_EXECUTOR_URL` | Required trusted `wss://` executor endpoint, without userinfo, query, or fragment. |
| `RESEARCH_EXECUTOR_CWD` | Required executor working directory as an absolute path or file URI. |
| `RESEARCH_EXECUTOR_TOKEN` | Optional executor bearer token; it is not printed. |

```sh
pnpm exec tsx packages/agents/examples/parallel-research.ts
```

The command uses the configured model service and a real WSS executor. You need a built native addon and a compatible executor service. The command is not a self-contained mock. CLI output contains actual lifecycle events and child snapshots, then the parent's answer, child result identities, and source receipts. A failure prints a fixed message and exits nonzero.

## Call and observe the example

`researchInParallel({sources, model, providerOptions, executorOptions, onProgress})` accepts exactly two sources selected by the application. Give each source a distinct ID, a title, and a nonempty `text` excerpt of at most 8,000 UTF-16 code units. Select trusted sources and configure the provider and executor before opening resources. Do not let a model choose URLs, filesystem paths, credentials, or a new source catalog. Pass `providerOptions.apiKey` or set `OPENAI_API_KEY` before calling. The function captures a nonblank key before opening resources.

The example approves only the two exact child assignments and parent collaboration waits. Each child starts with `fork_turns: 'none'` and may read only its assigned excerpt through `read_source`. Each assignment carries a fresh key. The callback binds that key to one actual child and checks the Session, turn, submission, and selected source before returning text.

The key stays out of result receipts and CLI output. Receipts retain the real actor, callback call metadata, selected source ID, and returned excerpt.

NativeAgents requires an Environment that declares `exec_command`, `write_stdin`, and `apply_patch`. The example supplies all three names and sets `approval: () => false`, denying executor effect dispatch. An empty Environment tool list does not satisfy NativeAgents admission. Denial does not remove the requirement for a real executor.

The optional synchronous `onProgress` callback receives actual observations and captured child snapshots. Snapshots do not update themselves. The result retains both issued child Turns and their completions. It verifies that each completion refers to its issued Turn and exposes the parent's exact completion as `result.parent`. Printed IDs, names, observations, and saved JSON do not grant control over another child incarnation or restore a live graph.

## Ownership and limits

The function owns its provider, Session, event iterator, and observer. It joins observation and Session cleanup before closing the provider and returning. The caller owns the executor service and closes it after the function settles. Cleanup failures remain failures rather than successful research results.

This lesson demonstrates research with two children. It does not promise ten-agent capacity, parallel external-effect execution, exactly-once effects, or general graph recovery. Tests use finite local model/executor fixtures with real native children; live model runs are not part of test authorization.

The package manifest includes this README and `parallel-research.ts` through its recursive examples rule. Packaged examples still require the matching native runtime and a separately provisioned executor.
