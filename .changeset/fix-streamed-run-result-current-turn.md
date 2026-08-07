---
'@openai/agents-core': patch
---

fix: make `StreamedRunResult.currentTurn` report only model turns that reach the request boundary, including across resumed runs
