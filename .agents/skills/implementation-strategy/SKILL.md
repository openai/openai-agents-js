---
name: implementation-strategy
description: Choose compatibility-aware scope for runtime and API changes in openai-agents-js. Use before initial implementation and each review-feedback batch to decide whether to patch, reset the design, preserve compatibility, or reject unsupported cases.
---

# Implementation Strategy

## Workflow

1. Identify the surface you are changing or reviewing: released public API, unreleased branch-local API, internal helper, persisted schema, wire protocol, CLI/config/env surface, or docs/examples only.
2. Determine the latest release tag to use as the compatibility baseline from `origin` first, and only fall back to local tags when remote tags are unavailable:
   ```bash
   BASE_TAG="$(.agents/skills/final-release-review/scripts/find_latest_release_tag.sh origin 'v*' 2>/dev/null || git tag -l 'v*' --sort=-v:refname | head -n1)"
   echo "$BASE_TAG"
   ```
   Report a local-tag fallback as potentially stale.
3. Record the implementation scope contract below before coding.
4. Identify the nearest existing implementation pipeline and the functions, types, or modules that are the source of truth for each affected concern. Prefer adapting the required input into that pipeline over creating parallel schema, metadata, validation, identity, conversion, or execution machinery.
5. Choose the smallest coherent change using the core decision rules. Add compatibility machinery only for a required supported boundary.
6. Before editing each review-feedback batch, run the review gate against the complete branch diff, not only the latest revision.
7. Before handoff, run the effectiveness check. If any answer is no, revise the design.

## Implementation scope contract

Record these four items in the plan or working notes, and update them before widening or narrowing the implementation:

1. **Required behavior:** The smallest user-visible scenario that must work.
2. **Compatibility requirements:** Supported released behavior or a durable boundary that must remain usable.
3. **Intentionally unsupported cases:** Nearby inputs or shapes to reject, including when and how rejection occurs.
4. **Supported alternative:** An existing wrapper, override, adapter, configuration, or lower-level API; state `none` when absent.

If the intentionally unsupported cases cannot be stated clearly, do not start by adding a general resolver. First define a narrower behavior contract. If no adequate supported alternative exists, add one only when the task requires it; do not invent one speculatively.

A released-version reproducer proves reachability, not support. Treat the exact shape as a compatibility requirement only when intentionally covered by public documentation, examples, tests, or typing; required by a durable boundary; or backed by concrete user reliance or maintainer intent. Otherwise record the risk and prefer early rejection with an existing supported alternative.

## Review-feedback gate

Repeat this gate before editing each new feedback batch:

```text
Review checkpoint:
- Root cause and required behavior:
- Compatibility evidence and unsupported cases:
- Source of truth:
- Behavior-space change: narrows / unchanged / widens
- Action: focused patch / complexity reset / reject as unsupported
```

Classify each finding as a required-behavior defect, supported compatibility requirement, another combination of the same implementation dimensions, or unrelated issue. Widening the behavior space requires new contract evidence.

If a second related finding would add another condition, protocol hop, compatibility case, or test permutation to the same abstraction, stop patching and run the complexity reset. Continue only when concrete evidence puts the exact case in the required or supported contract.

After a reset spec is frozen, classify each later finding as a violation of that spec, an evidence-backed reason to revise it, an intentionally unsupported case, or an unrelated issue. Do not resume incremental patching merely because the new finding is locally fixable.

Example: if successive findings require traversing a direct wrapper, nested wrapper, generic adapter, module interop boundary, and bound method, do not add another hop. Unless arbitrary wrapper graphs are supported, retain the required plain callable behavior and reject ambiguous wrappers before invocation.

## Core decision rules

- Preserve released public APIs, documented behavior, and supported durable boundaries, or provide an explicit migration path.
- Rewrite branch-local interfaces, internal helpers, same-branch tests, and post-release additions on `main` directly unless they already define a supported durable boundary.
- Unreleased persisted schema versions may be renumbered or folded into the next schema when intermediate snapshots are intentionally unsupported; update the support set and tests together.
- Do not equate a broad structural type, overload, generic, JavaScript reflection surface, module boundary, or third-party interface with support for every representable shape.
- Prefer the nearest existing pipeline and one source of truth for schema, documentation, validation, identity, package exports, conversion, and invocation.
- Add abstractions, state, classifications, branches, configuration, dependencies, or parallel paths only for a stated requirement, supported contract, or verified risk.
- Prefer deletion or direct replacement for unreleased code. Treat branch-local implementation and tests as disposable.
- Prefer an actionable construction- or validation-time error plus an existing alternative over partial interface emulation.
- Keep unrelated refactors and pre-existing failures out of the patch.
- Test the required behavior, the nearest supported path, and one representative case per unsupported category rather than every constructible permutation.
- Call out changes to supported released behavior or durable formats in the plan, changeset, and handoff.

## Complexity reset

Stop extending the current design when:

- Related findings keep combining the same dimensions, such as wrappers, overloads, union members, generics, binding, context injection, sync/async or streaming classification, runtime targets, or provider variants.
- The patch interprets TypeScript, JavaScript reflection, module resolution, or a third-party interface, or separately infers representations that can drift.
- A narrow requirement needs recursive resolution, cached modes, new state, or unrelated package or runtime-adapter changes.
- Tests enumerate mechanics or the full diff keeps growing while the required scenario remains small.

When a trigger fires:

1. Stop editing and freeze the current revision for analysis instead of addressing comments one by one.
2. Group findings by root cause and re-read the original requirement, scope contract, and supported release or durable boundaries.
3. Write a candidate finding-derived reset spec using those inputs. Do not treat accumulated review explanations, branch-local machinery, or same-branch tests as requirements.
4. Audit the candidate spec against every affected entry point and the nearest existing supported paths. Revise it as needed, then freeze it before resuming edits.
5. Compare the complete diff with the intended merge base or latest release tag, and map each abstraction, branch, and test to the frozen spec as `retain`, `replace`, or `delete`.
6. Delete machinery with no mapping, narrow the contract, and reject unsupported cases before side effects.
7. Rebuild tests around required behavior, supported compatibility, cross-entry-point consistency, and representative unsupported categories.
8. Evaluate later findings against the frozen spec. Stop and record new contract evidence before changing the spec or widening the behavior space.

Use this compact reset spec in the plan or working notes:

```text
Finding-derived reset spec:
- Original required outcome:
- Supported release or durable boundaries:
- Grouped findings and common root cause:
- Invariants across affected entry points:
- Allowed states and behavior:
- Rejected states, failure timing, and side-effect boundary:
- Trusted and untrusted boundaries:
- Single sources of truth:
- Persistence, resume, cleanup, or other lifecycle semantics:
- Non-goals and supported alternatives:
- Representative test categories:
- Diff reset: retain / replace / delete:
```

The candidate spec is a falsifiable design hypothesis, not a record of the current implementation. The audit may correct it before it is frozen. Once frozen, require explicit evidence to revise it and re-run the complete diff mapping after any revision.

Do not wait for the user or reviewer to request this reset when the signals are already present.

## SDK-specific decision rules

- Treat released package export maps, ESM/CJS entry points, public type signatures, `RunState`, session persistence, sandbox state, and documented model/provider configuration as compatibility-sensitive when they are supported across processes, runtimes, or machines.
- Treat persisted or resumed state as untrusted input. `RunState`, sandbox session state, provider snapshot state, and serialized session data must not be allowed to override trusted runtime configuration such as `baseUrl`, credentials, `secretRefs`, `launchParameters`, `environment`, `userParameters`, manifest roots, or provider blueprints.
- Retry or replay only when it is safe to assume the request was not accepted server-side. WebSocket timeouts, MCP reconnects, Realtime `response.create`, hosted tool calls, and sandbox operations can duplicate model or tool side effects if replayed after the server may have received the request.
- Avoid lossy conversion across OpenAI API surfaces. Responses items, Chat Completions messages, Realtime tools, compaction output, and SDK protocol items should either preserve supported data or fail fast in strict paths instead of silently dropping unsupported content, IDs, or metadata.
- Apply policy decisions across every input path, not only the primary run loop. Check streaming and non-streaming runs, session callbacks, local sessions, OpenAI Conversations sessions, compaction sessions, RunState resume, and public history replay for settings such as `reasoningItemIdPolicy`, approval policies, strict validation, and model defaults.
- Normalize and validate replacement data before destructive storage updates. Compaction, session replacement, and restore paths should only clear or replace persisted history after the new payload has been converted successfully, and failed partial clears should restore the original snapshot without duplicating items.
- Preserve API defaults when `undefined` is meaningful. Do not normalize omitted OpenAI or provider settings to concrete SDK defaults unless the API contract requires it; this is especially important for approval policies, lifecycle defaults, model settings, and provider options.
- Verify provider behavior against authoritative sources and, when practical, a small live probe. Provider docs, generated SDK types, and live backends can disagree on field names, timeout units, credential refresh behavior, and lifecycle semantics.

## Effectiveness check

Before declaring the design complete, answer all of these with concrete evidence:

- Can the required behavior be described without naming internal helper types or reflection mechanics?
- Does the implementation reuse the nearest existing pipeline rather than maintain a parallel interpretation?
- Does every new abstraction and branch map to the scope contract or a verified risk?
- Are unsupported neighboring cases rejected before side effects with an existing alternative identified?
- Do the complete diff and tests cover the contract without making every constructible permutation supported?
- Does the latest review revision shrink or preserve the behavior space rather than widen it without evidence?
- When a complexity reset occurred, does every retained abstraction, branch, and test map to the frozen reset spec, with later findings classified against it?

## When to stop and confirm

- The change would alter supported behavior shipped in the latest release tag, or concrete evidence shows material reliance on behavior that the release incidentally accepted.
- The change would modify durable external data, protocol formats, or serialized state.
- The correct solution would materially expand beyond the requested outcome or require unrelated architectural work.
- A complexity reset trigger fires and the narrower replacement would change an already released supported contract rather than branch-local code.
- The user explicitly asked for backward compatibility, deprecation, or migration support.

## Output expectations

When this skill materially affects the implementation approach, state the decision briefly in your reasoning or handoff, for example:

- `Compatibility boundary: latest release tag v0.x.y; branch-local interface rewrite, no shim needed.`
- `Implementation scope contract: support X; preserve Y; reject Z before side effects; use supported alternative W, or none exists.`
- `Complexity reset: repeated edge-case combinations show the approach is too broad; redesign from the original requirement instead of adding another branch.`
- `Finding-derived reset spec: findings F1-F3 expose invariant X across entry points A-C; freeze that contract, delete unmapped machinery, and review later findings against it.`
