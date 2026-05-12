---
name: implementation-strategy
description: Decide how to implement runtime and API changes in openai-agents-js before editing code. Use when a task changes exported APIs, runtime behavior, schemas, tests, or docs and you need to choose the compatibility boundary, whether shims or migrations are warranted, and when unreleased interfaces can be rewritten directly.
---

# Implementation Strategy

## Overview

Use this skill before editing code when the task changes runtime behavior or anything that might look like a compatibility concern. The goal is to keep implementations simple while protecting real released contracts and genuinely supported external state.

## Quick start

1. Identify the surface you are changing: released public API, unreleased branch-local API, internal helper, persisted schema, wire protocol, CLI/config/env surface, or docs/examples only.
2. Determine the latest release boundary from `origin` first, and only fall back to local tags when remote tags are unavailable:
   ```bash
   LATEST_RELEASE_TAG="$(
     git ls-remote --tags --refs origin 'v*' 2>/dev/null |
       awk -F/ '{print $3}' |
       sort -V -r |
       head -n1
   )"
   if [ -z "$LATEST_RELEASE_TAG" ]; then
     LATEST_RELEASE_TAG="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
   fi
   printf '%s\n' "$LATEST_RELEASE_TAG"
   ```
3. Judge breaking-change risk against that latest release tag, not against unreleased branch churn or post-tag changes already on `main`. If the command fell back to local tags, treat the result as potentially stale and say so.
4. Prefer the simplest implementation that satisfies the current task. Update callers, tests, docs, and examples directly instead of preserving superseded unreleased interfaces.
5. Add a compatibility layer only when there is a concrete released consumer, an otherwise supported durable external state that requires it, or when the user explicitly asks for a migration path.

## Compatibility boundary rules

- Released public API or documented external behavior: preserve compatibility or provide an explicit migration path.
- Persisted schema, serialized state, wire protocol, CLI flags, environment variables, and externally consumed config: treat as compatibility-sensitive once they are released or otherwise have a supported external consumer. Unreleased post-tag formats that only exist on the current branch can still be rewritten directly.
- Interface changes introduced only on the current branch: not a compatibility target. Rewrite them directly.
- Interface changes present on `main` but added after the latest release tag: not a semver breaking change by themselves. Rewrite them directly unless they already back a released or otherwise supported durable format.
- Internal helpers, private types, same-branch tests, fixtures, and examples: update them directly instead of adding adapters.

## Runtime and platform risk boundaries

Use these checks alongside the release-boundary decision. They are not generic programming rules; they are recurring OpenAI Agents SDK and OpenAI platform failure modes.

- Treat persisted or resumed state as untrusted input. `RunState`, sandbox session state, provider snapshot state, and serialized session data must not be allowed to override trusted runtime configuration such as `baseUrl`, credentials, `secretRefs`, `launchParameters`, `environment`, `userParameters`, manifest roots, or provider blueprints.
- Retry or replay only when it is safe to assume the request was not accepted server-side. WebSocket timeouts, MCP reconnects, Realtime `response.create`, hosted tool calls, and sandbox operations can duplicate model or tool side effects if replayed after the server may have received the request.
- Avoid lossy conversion across OpenAI API surfaces. Responses items, Chat Completions messages, Realtime tools, compaction output, and SDK protocol items should either preserve supported data or fail fast in strict paths instead of silently dropping unsupported content, IDs, or metadata.
- Apply policy decisions across every input path, not only the primary run loop. Check streaming and non-streaming runs, session callbacks, local sessions, OpenAI Conversations sessions, compaction sessions, RunState resume, and public history replay for settings such as `reasoningItemIdPolicy`, approval policies, strict validation, and model defaults.
- Normalize and validate replacement data before destructive storage updates. Compaction, session replacement, and restore paths should only clear or replace persisted history after the new payload has been converted successfully, and failed partial clears should restore the original snapshot without duplicating items.
- Preserve API defaults when `undefined` is meaningful. Do not normalize omitted OpenAI or provider settings to concrete SDK defaults unless the API contract requires it; this is especially important for approval policies, lifecycle defaults, model settings, and provider options.
- Verify provider behavior against authoritative sources and, when practical, a small live probe. Provider docs, generated SDK types, and live backends can disagree on field names, timeout units, credential refresh behavior, and lifecycle semantics.

## Default implementation stance

- Prefer deletion or replacement over aliases, overloads, shims, feature flags, and dual-write logic when the old shape is unreleased.
- Do not preserve a confusing abstraction just because it exists in the current branch diff.
- If review feedback claims a change is breaking, verify it against the latest release tag and actual external impact before accepting the feedback.
- If a change truly crosses the latest released contract boundary, call that out explicitly in the ExecPlan, changeset, and user-facing summary.

## When to stop and confirm

- The change would alter behavior shipped in the latest release tag.
- The change would modify durable external data or protocol formats that are already released or otherwise supported.
- The user explicitly asked for backward compatibility, deprecation, or migration support.

## Output expectations

When this skill materially affects the implementation approach, state the decision briefly in your reasoning or handoff, for example:

- `Compatibility boundary: latest release tag v0.x.y; branch-local interface rewrite, no shim needed.`
- `Compatibility boundary: latest release tag v0.x.y; unreleased RunState snapshot rewrite, no shim needed.`
- `Compatibility boundary: released RunState schema; preserve compatibility and add migration coverage.`
