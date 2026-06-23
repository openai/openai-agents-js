# Conversation State Ownership

Use this reference for explicit history replay, SDK sessions, `conversationId`, `previousResponseId`, model-input filtering, compaction strategy, retry, or interrupted-run resume.

## Choose the State Owner

| Strategy | Owner | Next model input |
| --- | --- | --- |
| Explicit `result.history` replay | Application | Full replay-ready history plus new input |
| SDK `Session` | Application storage plus runner | Stored history combined with new input |
| `conversationId` | OpenAI Conversations/Responses | Conversation ID plus new delta |
| `previousResponseId` | OpenAI Responses | Previous response ID plus new delta |
| `RunState` resume | Serialized SDK run | Continue the same interrupted run; this is not a new conversation strategy |

Do not create two authoritative histories accidentally. When server-managed continuation is active, the runner excludes prior SDK-session history from model input and limits local persistence to new process-local items.

## Server Conversation Tracker

- `ServerConversationTracker` owns which original and generated items have already reached or come from the server. Use object identity in one live process and stable item/call/content keys when clones, filters, or serialization break identity.
- Capture the latest response that actually has a response ID. Do not erase a valid `previousResponseId` because an adjacent provider response lacks one.
- Mark prepared input as sent only when the request has crossed the relevant success boundary. Streaming abort before the first event and abort after partial tool-call events require different reconciliation.
- Skip approval placeholders and server-echoed output when calculating the next delta. Preserve unsent tool outputs and filtered replacements that the server has not acknowledged.

## Filters, Sessions, and Resume

- `callModelInputFilter` receives a deep-cloned prepared payload and must return an input array. Persist filtered clones so session history reflects redaction or truncation rather than the unfiltered source.
- Track filtered items back to their originals so delta bookkeeping marks the items the model actually received. Rewind or preserve that mapping according to whether a failed attempt may have advanced server state.
- `RunState` persists conversation identifiers and primes tracker state from prior model responses. Resume must not resend acknowledged input, lose unsent outputs, or increment the turn count without a model call.
- Conversation continuation carries context into a new turn. RunState resume continues a paused turn. Do not substitute one for the other.

## Compaction

- `previous_response_id` compaction requires a usable stored response chain. `input` compaction rebuilds from client-held items and is the safe path when the chain is unavailable or `store` prevents later lookup.
- Normalize compacted output before destructive session replacement. If replacement fails after mutation, restore the prior history or surface both replacement and restore failures explicitly.

## Review Checklist

1. Name the single authoritative state owner and whether each request receives full history or a delta.
2. Test first turn, follow-up, filter, retry, streaming abort, interruption, serialized resume, and compaction.
3. Test tool calls and outputs separately; item IDs and call IDs serve different dedupe roles.
4. Confirm local sessions do not introduce duplicate server-owned history.
5. Recheck OpenAI platform semantics with `$openai-knowledge`; keep this file limited to SDK behavior.

## Sources

- `packages/agents-core/src/runner/conversation.ts`
- `packages/agents-core/src/runner/turnPreparation.ts`
- `packages/agents-core/src/run.ts`
- `packages/agents-core/src/runState.ts`
- `packages/agents-openai/src/memory/openaiConversationsSession.ts`
- `packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`
- `packages/agents-core/test/runner/conversation.test.ts`
- `packages/agents-core/test/agentScenarios.test.ts`
- `packages/agents-openai/test/openaiResponsesCompactionSession.test.ts`
- `docs/src/content/docs/guides/running-agents.mdx`
- `docs/src/content/docs/guides/sessions.mdx`
