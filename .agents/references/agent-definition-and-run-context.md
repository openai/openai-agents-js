# Agent Definition and Run Context

Use this reference for `Agent` configuration, cloning, dynamic instructions, enabled tools and handoffs, nested agent tools, `RunContext`, usage, or public-versus-prepared agent identity.

## Agent Definition and Resolution

- Resolve dynamic instructions, callable tool enablement, and callable handoff enablement with the current `RunContext` for each turn. Do not cache one run's resolved set on a reusable `Agent`.
- Use the same resolved tool and handoff view for model exposure, collision checks, dispatch, approvals, tracing, and Realtime updates. Resolving independently can expose one set and execute another.
- `Agent.clone()` copies configuration into a new agent but does not make contained tools, hooks, handoffs, models, or caller objects deeply independent. Do not promise mutation isolation that the implementation does not provide.
- Prepared sandbox agents and other internal wrappers may add runtime tools or instructions, but hooks, filters, results, and public identity should continue to identify the public agent unless an internal identity is explicitly part of the contract.
- The effective output type follows the agent and handoff path that produced the final candidate. Preserve the output union across typed handoffs instead of assuming the starting agent's output type.

## Context Ownership

- `RunContext.context` is application-local state and is not model input unless user code adds it explicitly. `RunContext.usage` is the run-wide mutable usage accumulator; merge each model attempt exactly once.
- Context forks share the application object, usage, and approval state while allowing scoped `toolInput`. Use `withToolInput()` and `withoutToolInput()` so nested agent tools do not leak stale structured input into unrelated calls.
- Preserve custom `RunContext` subclasses only through `_createFork()`; the base implementation cannot reconstruct subclass behavior automatically.
- Nested `Agent.asTool()` runs have their own runner state, interruption scope, and model/tool settings merge. They may share application state and usage, but must not reuse parent approvals merely because a call ID or tool name matches.

## Usage

- Aggregate totals and `requestUsageEntries` must stay consistent across streaming, retries, handoffs, nested agents, resume, and adapters. Preserve authoritative request entries rather than synthesizing duplicates from totals.
- A streamed response's usage is incomplete until its terminal event and stream driver complete. Do not finalize result or trace usage from an intermediate text delta.
- Treat zero-token failed attempts, snake_case provider fields, and endpoint metadata explicitly; do not convert missing provider data into invented token counts.

## Review Checklist

1. Resolve dynamic agent surfaces against the current context and public identity.
2. Verify clone and nested-tool behavior without assuming deep copies or shared approvals.
3. Test scoped `toolInput`, custom context subclasses, and nested resume behavior.
4. Check handoff output typing and prepared-agent identity.
5. Compare aggregate and per-request usage after streaming, retry, handoff, nested runs, and resume.

## Sources

- `packages/agents-core/src/agent.ts`
- `packages/agents-core/src/agentToolInput.ts`
- `packages/agents-core/src/agentToolRunConfig.ts`
- `packages/agents-core/src/runContext.ts`
- `packages/agents-core/src/usage.ts`
- `packages/agents-core/test/agent.test.ts`
- `packages/agents-core/test/agentScenarios.test.ts`
- `packages/agents-core/test/runContext.test.ts`
- `packages/agents-core/test/usage.test.ts`
- `docs/src/content/docs/guides/agents.mdx`
- `docs/src/content/docs/guides/context.mdx`
