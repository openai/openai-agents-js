# RunState Schema and Resume

Use this reference for serialized `RunState`, schema versions, approvals, agent/tool reconstruction, traces, conversation identifiers, sandbox state, or interrupted-run resume.

## Compatibility Boundary

- `RunState` is a versioned durable SDK snapshot. `serialize()` emits `CURRENT_SCHEMA_VERSION`; deserialization must continue to accept every version listed in `SUPPORTED_SCHEMA_VERSIONS`.
- Bump the schema when a released snapshot changes meaning or requires new durable data. Unreleased versions on `main` may be folded into the same next version when no supported snapshot consumer exists.
- Optional/defaulted fields preserve old readers' meaning. A new item or action type also needs Zod schema support, serialization, deserialization, runtime rehydration, and a prior-version decision.
- Reject missing or unsupported versions with a user-facing error. Do not guess which historical layout an unversioned payload used.

## Identity and Rehydration

- Rebuild agents from the graph reachable from the starting agent. Distinct agents with the same name are ambiguous unless serialized agent identity disambiguates them; reject or preserve identity instead of silently choosing one.
- Rehydrate function, deferred/tool-search, MCP, computer, shell, apply-patch, and sandbox-injected tools through the current agent/tool set. Preserve declared names, namespaces, call IDs, approval attribution, and enabled-state checks.
- Adding MCP servers or runtime tools after serialization must not make an otherwise valid snapshot unreadable. Conversely, do not execute a resumed tool that is disabled or cannot be resolved under the replacement context.
- Rehydrate interruption items as their public `RunItem` subclasses so approval APIs and result history behave like a live interruption.

## Resume State

- Preserve `_currentTurnInProgress`, current step, generated items, last processed response, pending nested agent runs, persisted-item count, conversation IDs, reasoning-item policy, and rejection messages needed to continue without replay or duplicated side effects.
- Approval and rejection decisions are scoped by tool identity and call ID. Preserve sticky `alwaysReject` messages and qualified names across serialization.
- Runtime callbacks, provider clients, retry policies, and other executable objects are not made durable merely by serializing surrounding settings. Rebind them from current configuration on resume.
- Serialized context can contain application data; custom data must be JSON-compatible and must not include secrets unless the application explicitly accepts that durability boundary.

## Tracing and Sandbox State

- Restore trace/span identity only when the snapshot carries it, then apply current per-run tracing overrides. Clearing resumed trace state must prevent accidental parentage without corrupting the rest of the run.
- Sandbox session state is versioned inside RunState. Treat it as untrusted persisted input and recreate live clients, credentials, and tools from current trusted configuration.

## Review Checklist

1. Compare the change with the latest released schema and decide bump, backward read, or unreleased fold-in.
2. Round-trip every new field and test the oldest supported version.
3. Resume before model call, pending approval, nested agent tool, and partially persisted streaming turn.
4. Test duplicate agent/tool names, missing tools, newly added MCP servers, and disabled tools.
5. Confirm traces, conversation IDs, context, and sandbox state restore without serializing live clients or secrets.

## Sources

- `packages/agents-core/src/runState.ts`
- `packages/agents-core/src/run.ts`
- `packages/agents-core/src/result.ts`
- `packages/agents-core/src/agentToolSourceRegistry.ts`
- `packages/agents-core/src/runner/modelOutputs.ts`
- `packages/agents-core/test/runState.test.ts`
- `packages/agents-core/test/agentScenarios.test.ts`
- `packages/agents-core/test/hitlMemorySessionScenario.test.ts`
- `packages/agents-core/test/sandboxRuntime.test.ts`
- `docs/src/content/docs/guides/human-in-the-loop.mdx`
