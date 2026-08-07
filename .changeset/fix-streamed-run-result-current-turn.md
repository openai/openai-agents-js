---
'@openai/agents-core': patch
---

fix: make StreamedRunResult.currentTurn report the number of model turns admitted

`StreamedRunResult.currentTurn` was declared as a plain field initialized to `0` and never written, so it always read `0` no matter how many turns a streamed run executed — only the private `RunState._currentTurn` was incremented. It stays a writable public field, and the streaming runner now sets it at the point a turn is admitted: after the `maxTurns` check and any blocking input guardrails have passed, immediately before the model request starts. It is also seeded from a resumed state so a continued run does not restart at `0`.

Because `RunState._currentTurn` is incremented at the _start_ of a turn — before both checks — surfacing it verbatim would over-report: a handled max-turn boundary (e.g. `maxTurns: 0`) and a first-turn blocking-guardrail tripwire would each report `1` for a run that never reached the model. Both now correctly report `0`.
