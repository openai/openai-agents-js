# Tool Identity and Routing

Use this reference for tool names, namespaces, lookup, approvals, call IDs, collisions, deferred tools, MCP names, handoff routing, or trace labels.

## Identity Layers

- Keep declared name, optional namespace, qualified lookup name, model-visible name, display name, provider call ID, and item ID distinct. One string is not a safe substitute for every layer.
- Use `toolQualifiedName()` and the helpers in `toolIdentity.ts` and `tooling.ts`. Do not add local concatenation or fallback rules in converters, approvals, traces, or adapters.
- A normal namespaced function tool resolves by qualified name. A top-level deferred tool can be self-namespaced on the wire; preserve the special bare-name preference so it does not collide with a real namespace group.
- Collision checks must use the same enabled tool and handoff set exposed to the model. Disabled handoffs do not reserve names; local functions and already allocated normalized MCP names do.

## MCP and Handoffs

- Prefixing local MCP tool names with a server name changes the model-visible collision-safe wrapper name, not the original name sent back to the MCP server.
- Sanitize and length-limit generated MCP names deterministically, including a stable collision suffix. Cache entries must rebind wrappers to the current server instance.
- Handoff tool names are routing identities. Keep text-runner and Realtime handoff conversion aligned and preserve explicit clone overrides.

## Call IDs and Tool Search

- Match tool calls and outputs with provider call IDs when available, then stable item IDs, then a controlled generated fallback. Do not consume a pending client call ID for a server-executed tool-search output.
- Repeated tool-search output with the same call ID is a replacement/update, not necessarily a duplicate to drop. Out-of-order results must find the correct pending call.
- Persist qualified names and approval IDs in RunState so resume routes to the same tool even when bare names repeat across namespaces or agents.

## Review Checklist

1. Name every identity layer used by the change and the helper that owns it.
2. Test bare, namespaced, self-namespaced deferred, MCP-prefixed, handoff, and duplicate-name cases.
3. Verify the model exposure set and dispatch/approval maps use the same enabled tools.
4. Test missing, camelCase, snake_case, out-of-order, and repeated call IDs.
5. Round-trip identity through stream events, sessions, adapters, tracing, and RunState.

## Sources

- `packages/agents-core/src/toolIdentity.ts`
- `packages/agents-core/src/tooling.ts`
- `packages/agents-core/src/tool.ts`
- `packages/agents-core/src/handoff.ts`
- `packages/agents-core/src/mcp.ts`
- `packages/agents-core/src/runner/modelOutputs.ts`
- `packages/agents-core/src/runState.ts`
- `packages/agents-core/test/toolIdentity.test.ts`
- `packages/agents-core/test/tooling.test.ts`
- `packages/agents-core/test/mcpCache.test.ts`
- `packages/agents-core/test/runState.test.ts`
