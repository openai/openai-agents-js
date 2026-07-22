---
'@openai/agents-core': patch
---

fix: cap StreamedRunResult.currentTurn at maxTurns and surface the real turn count

`StreamedRunResult.currentTurn` was declared as a plain field initialized to `0` and never updated, so it always read `0` no matter how many turns a streamed run executed — only the private `RunState._currentTurn` was incremented (once per model request in `beginTurn`). It is now a getter that surfaces the live turn count, capped at the configured `maxTurns`: because the runner increments the counter before the limit check, a handled max-turn boundary (e.g. `maxTurns: 0`) would otherwise report one turn more than the limit admitted. When `maxTurns` is `null` (no limit) the raw counter is surfaced unchanged.
