# Realtime Session Lifecycle

Use this reference for `RealtimeSession` state, agent updates, response sequencing, tools, guardrails, history, handoffs, listeners, or cleanup.

## Session Ownership

- `RealtimeSession` owns the active agent, local history, available MCP tools, response sequencing, tool executions, guardrails, and subscriptions to one transport. The transport owns the network/media connection.
- Resolve dynamic instructions, tools, and handoffs before sending a session update. Preserve the complete last session configuration and overwrite only intended dynamic fields so agent handoff does not drop audio formats, modalities, speed, turn detection, or other caller settings.
- A Realtime agent shares the session/model conversation. Handoff updates active instructions/tools/voice constraints; it does not start an independent text-runner loop.
- Once an agent has spoken, changing to an incompatible voice can fail. Validate or preserve voice across handoff rather than issuing an invalid session update.

## Response Sequencing and History

- `ResponseCreateSequencer` serializes create/cancel transitions. Do not send a new `response.create` while the previous turn is active or cancellation is unresolved.
- Associate create errors with the request event that caused them. A stale error or terminal event must not release or fail a newer queued request.
- Local history is a projection of Realtime events. Add items before later transcript/audio updates, preserve stable item IDs, and emit `history_added` and `history_updated` with their documented timing.
- Audio storage is opt-in to limit client memory. Omitting local audio bytes must not discard transcript, format, status, or item identity.

## Tools, Guardrails, and Handoffs

- Recompute enabled local, handoff, hosted, and MCP tool exposure when the active agent changes. Filter MCP tools by the active agent's server labels.
- Keep approval and input/output guardrail order aligned with the text runner where contracts overlap. An undecided call emits `tool_approval_requested`; rejected or guarded calls return model-visible output without invocation.
- Emit agent/tool start and end events once. Tool errors, guardrail trips, and handoffs must not leave the response sequencer or available-tool set stale.
- Output guardrails can interrupt audio generation after partial output. Emit the interruption and prevent guarded content from continuing to the client.

## Entry, Exit, and Failure

- Attach transport listeners once per session and detach them on close or reconnect. Repeated close must be safe and must not duplicate transport close or leave event iterators waiting.
- Resolve lazy API keys at connection time and do not persist or log them. A failed connect must reset session/transport state enough for a controlled retry.
- Surface transport and tool failures through the session error event while preserving the original failure for diagnostics.

## Review Checklist

1. Test connect, failed connect, reconnect, repeated close, and listener cleanup.
2. Test agent updates and handoffs with custom audio/session settings and voice constraints.
3. Exercise response create/cancel races and stale terminal/error events.
4. Verify history item/transcript ordering with and without stored audio.
5. Compare tool approvals, guardrails, hooks, and failure cleanup with the text runner where intended.

## Sources

- `packages/agents-realtime/src/realtimeSession.ts`
- `packages/agents-realtime/src/realtimeAgent.ts`
- `packages/agents-realtime/src/responseCreateSequencer.ts`
- `packages/agents-realtime/src/realtimeSessionEvents.ts`
- `packages/agents-realtime/src/items.ts`
- `packages/agents-realtime/test/realtimeSession.test.ts`
- `packages/agents-realtime/test/realtimeAgentHandoffs.test.ts`
- `packages/agents-realtime/test/guardrail.test.ts`
- `docs/src/content/docs/guides/voice-agents.mdx`
- `docs/src/content/docs/guides/voice-agents/build.mdx`
