---
'@openai/agents-core': minor
'@openai/agents-openai': patch
---

fix: Preserve bounded nested numeric token usage breakdowns across streamed runs, usage accounting, and saved run state (schema 1.23, with backward reads of earlier snapshots; #2082); usage detail values now require narrowing to numbers before arithmetic.
