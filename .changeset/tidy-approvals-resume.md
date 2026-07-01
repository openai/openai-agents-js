---
'@openai/agents-core': patch
---

fix(core): stop resending resolved tool results across consecutive streamed approvals

When a streamed run started with `previousResponseId` was resumed through more than one tool-approval interruption, the server conversation tracker re-primed each earlier approval's `function_call_output` on every resume. Because `previousResponseId` had already advanced past those calls, the follow-up request failed with `400 No tool call found for function call output with call_id ...`. `primeFromState` now marks tool results whose function call belongs to an already resolved response as sent, so only the latest turn's pending results are replayed.
