---
'@openai/agents-core': patch
---

Fix `StreamedRunResult.currentTurn` always returning `0`

`StreamedRunResult.currentTurn` was declared as a plain field initialized to `0` and never updated, so it always read `0` no matter how many turns a streamed run executed — only the private `RunState._currentTurn` was incremented (once per model request in `beginTurn`). It is now a getter that delegates to `RunState._currentTurn`, matching every other accessor on the result (e.g. `currentAgent`, and the delegating getters on `RunResultBase`), so it reflects the real turn count live.
