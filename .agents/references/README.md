# SDK Maintainer References

This directory captures long-lived implementation contracts of the OpenAI Agents TypeScript SDK that are not replaceable by OpenAI API facts from `$openai-knowledge` or by user-facing docs alone. Use these references to preserve ownership, ordering, compatibility, failure, and cross-runtime semantics while changing or reviewing the SDK.

## Usage

Start with the map below and open only the references relevant to the affected boundary. Treat every reference as background, not as proof that a current issue is valid or a current patch is correct. Verify the claim against the current remote change, source, tests, docs, latest release boundary, and focused runtime evidence.

During implementation or dedicated repository-maintenance work, update the narrowest owning reference when a reusable invariant is established or ownership moves. During ordinary issue or PR review, keep this directory read-only and recommend a separate reference update unless the user explicitly includes it in scope.

## Inclusion Criteria

Keep knowledge here only when it is SDK-specific, stable across multiple tasks or releases, easy to violate from one local path, and expensive to reconstruct repeatedly. Prefer state owners, lifecycle order, compatibility boundaries, and required cross-path parity over module summaries.

Do not store current issue or PR status, one-off fixes, generic review methodology, release notes, translated documentation, or OpenAI platform facts available from `$openai-knowledge`. History is discovery evidence; each retained rule must still be supported by current source, tests, docs, or a released contract.

## Reference Map

| Reference | Read before changing or reviewing |
| --- | --- |
| [Public API, package, and runtime boundaries](public-api-package-and-runtime-boundaries.md) | Package exports, convenience re-exports, ESM/CJS/types, optional dependencies, import side effects, or Node/browser/workerd shims |
| [Agent definition and run context](agent-definition-and-run-context.md) | Agent configuration, cloning, dynamic instructions, enabled tools/handoffs, nested agent tools, context forks, or usage |
| [Runner lifecycle](runner-lifecycle.md) | Turns, guardrails, handoffs, interruption, cancellation, hooks, final output, or streaming parity |
| [Run item and stream lifecycle](run-item-and-stream-lifecycle.md) | New item types, model output processing, stream events, result extraction, replay, persistence, or custom data |
| [Schema and Zod boundaries](schema-and-zod-boundaries.md) | Function-tool schemas, structured outputs, strict conversion, Zod v3/v4, or provider schema conversion |
| [Conversation state ownership](conversation-state-ownership.md) | Explicit replay, `conversationId`, `previousResponseId`, filtering, continuation, compaction strategy, retries, or resume |
| [Session persistence](session-persistence.md) | Session callbacks, stored input, history mutation, per-turn writes, rollback, or compaction replacement |
| [RunState schema and resume](runstate-schema-and-resume.md) | Serialized state, schema versions, approvals, agent/tool reconstruction, traces, or interrupted-run resume |
| [Tool identity and routing](tool-identity-and-routing.md) | Names, namespaces, lookup, call IDs, approvals, collisions, deferred tools, MCP names, or trace labels |
| [Tool execution and approval lifecycle](tool-execution-and-approval-lifecycle.md) | Planning, approval, guardrails, concurrency, aborts, timeouts, hooks, failure conversion, or tool-choice reset |
| [MCP transport, cache, and shims](mcp-transport-cache-and-shims.md) | Local MCP connections, stdio/SSE/streamable HTTP, requests, cache/filtering, retries, cancellation, or cleanup |
| [Model, provider, and conversion boundaries](model-provider-and-conversion-boundaries.md) | Model resolution, settings merge, Responses/Chat Completions, provider data, raw events, retries, or WebSocket Responses |
| [Tracing and runtime context](tracing-and-runtime-context.md) | Trace/span context, processors, export, flush, shutdown, resume, runtime storage, usage, or sensitive data |
| [Realtime session lifecycle](realtime-session-lifecycle.md) | Realtime agent/session state, response sequencing, tools, guardrails, history, handoffs, listeners, or cleanup |
| [Realtime transport, audio, and events](realtime-transport-audio-and-events.md) | WebRTC, WebSocket, SIP, Twilio, Cloudflare, connection state, audio formats, transcripts, or event payloads |
| [Sandbox runtime and provider boundaries](sandbox-runtime-and-provider-boundaries.md) | Sandbox preparation, sessions, manifests, mounts, path grants, snapshots, credentials, timeout, resume, or cleanup |
| [Extension adapter boundaries](extension-adapter-boundaries.md) | AI SDK model/UI adapters, provider metadata, usage, reasoning, tool-call translation, aborts, or stream completion |

## Maintenance Rules

Keep each detailed rule in one owning reference and cross-link adjacent documents instead of copying it. Describe current architecture, not the chronology of a bug. Use repository-relative current source, test, and English-doc paths as anchors. Remove or rewrite guidance when ownership moves, and compare compatibility claims with the latest release tag rather than unreleased branch-local churn.
