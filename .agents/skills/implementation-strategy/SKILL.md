---
name: implementation-strategy
description: Decide how to implement or review runtime and API changes in openai-agents-js. Use when a task changes or reviews exported APIs, runtime behavior, schemas, tests, or docs and you need to choose the compatibility boundary, the smallest coherent implementation, whether shims or migrations are warranted, and when unreleased interfaces can be rewritten directly.
---

# Implementation Strategy

## Overview

Use this skill before editing or reviewing code when the task changes runtime behavior, an externally visible interface, or data that must remain usable across releases, processes, runtimes, or machines. The goal is to keep implementations and review requests focused while protecting behavior and data formats the project has committed to support.

## Quick start

1. Identify the surface you are changing or reviewing: released public API, unreleased branch-local API, internal helper, persisted schema, wire protocol, CLI/config/env surface, or docs/examples only.
2. Determine the latest release tag to use as the compatibility baseline from `origin` first, and only fall back to local tags when remote tags are unavailable:
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
3. Write an implementation scope contract before coding: the required behavior, compatibility requirements, intentionally unsupported cases and their failure behavior, and an already-supported alternative for those cases or that none exists.
4. Identify the nearest existing implementation pipeline and the functions, types, or modules that are the source of truth for each affected concern. Prefer adapting the required input into that pipeline over creating parallel schema, metadata, validation, identity, conversion, or execution machinery.
5. Judge breaking-change risk against the latest release tag, not against unreleased branch churn or post-tag changes already on `main`. If the command fell back to local tags, treat the result as potentially stale and say so.
6. Apply the scope and simplicity rules below, including the complexity reset triggers, before choosing the implementation or review recommendation.
7. Add a compatibility layer only when the old interface or behavior shipped in the latest release and must remain usable, an explicitly supported durable data format requires it, or the user explicitly asks for a migration path.

## Scope and simplicity rules

- Make the smallest coherent change that fully satisfies the current task and preserves the behavior identified in the compatibility requirements.
- Prefer existing patterns and direct implementations. Add a new abstraction, general-purpose helper, configuration knob, dependency, compatibility layer, feature flag, or parallel code path only when a concrete current requirement or supported contract needs it.
- Do not equate accepting a broad structural type, union, generic, overload, or third-party interface with supporting every constructible implementation shape. State exactly which inputs, call shapes, runtime targets, and behaviors are supported.
- Prefer adapting the required case into the existing source-of-truth path. Do not create a second resolver or contract for schema, validation, identity, documentation, package exports, conversion, or invocation when the existing path can consume a normalized adapter.
- Require every new piece of state, classification, branching, or metadata to have one source of truth and to satisfy one stated requirement. Cached capability or dispatch facts that can disagree with the runtime value are a strong signal to simplify.
- Trace only the code paths being changed and the contracts they rely on. Expand the investigation or implementation only when concrete evidence or validation exposes another required path.
- Keep root-cause fixes within the requested boundary. Leave unrelated refactors, cleanup, feature work, and pre-existing failures out of the patch; report them separately when they materially affect the result.
- Add focused tests for the required behavior, behavior matching the nearest existing path, and one representative case for each intentionally unsupported category. Do not turn a matrix of type-system, module-format, runtime-target, or provider permutations into a product contract merely because those permutations can be constructed.

## Implementation scope contract

An implementation scope contract is a short, updateable engineering decision record, not a new public API promise. Record these four items in the plan or working notes before implementation, and update them before widening or narrowing the implementation:

1. **Required behavior:** The smallest user-visible scenario that must work.
2. **Compatibility requirements:** Behavior from the latest release or an explicitly supported durable boundary that must remain unchanged, plus any user-approved migration or deprecation requirement for behavior that will change.
3. **Intentionally unsupported cases:** Specific nearby inputs, call shapes, runtime targets, or compositions the implementation will reject instead of inferring or emulating, including where and how rejection occurs.
4. **Supported alternative:** An already-supported wrapper, explicit override, typed adapter, configuration, or lower-level API users can choose for an intentionally unsupported case. State `none` when no such alternative exists.

If the intentionally unsupported cases cannot be stated clearly, do not start by adding a general resolver. First define a narrower behavior contract. If no adequate supported alternative exists, add one only when the task requires it; do not invent one speculatively.

## Complexity reset triggers

Stop extending the current implementation, discard assumptions introduced by the current patch, and redesign from the original requirement when any of these signals appears:

- Review fixes repeatedly add cases formed by combining the same independent dimensions, such as wrappers, overloads, union members, generic specialization, context injection, sync/async or streaming modes, ESM/CJS/browser/Node/workerd targets, or provider variants.
- The patch begins to interpret TypeScript's type system, JavaScript reflection, module resolution, or a third-party interface rather than implement the requested SDK behavior.
- Schema generation, validation, identity, documentation, package exports, conversion, and invocation depend on separately inferred representations that can drift apart.
- A narrow feature requires new state objects, cached modes, recursive resolution, or changes across otherwise unrelated packages or runtime adapters.
- Most new tests enumerate permutations of implementation mechanics rather than the promised user-facing contract.
- The implementation keeps growing after each review cycle while the original required scenario remains small.

When a trigger fires:

1. Stop addressing comments one by one.
2. Group all findings by root cause and identify the unsupported dimensions they expose.
3. Re-read the original request and list the behavior from the latest release that must remain compatible.
4. Compare the complete diff with the merge base of the intended target branch, or with the latest release tag when it is the compatibility baseline, not only with the previous review revision.
5. Delete or directly replace branch-local machinery that is not required. Unreleased code and its tests are not sunk costs.
6. Narrow the supported contract and reject intentionally unsupported cases before model/tool requests, persisted mutations, or other side effects. Point to an already-supported alternative when one exists.
7. Rebuild the regression suite around the required behavior, behavior matching the nearest existing implementation path, and one representative test for each intentionally unsupported category instead of every possible composition.

Do not wait for the user or reviewer to request this reset when the signals are already present.

## Compatibility boundary rules

- Released public API or documented external behavior: preserve compatibility or provide an explicit migration path.
- Persisted schema, serialized state, wire protocol, CLI flags, environment variables, and externally consumed config: treat as compatibility-sensitive once they are released or otherwise have a supported external consumer. Unreleased post-tag formats that only exist on the current branch can still be rewritten directly.
- TypeScript-specific durable surfaces such as package export maps, ESM/CJS entry points, public type signatures, `RunState`, session persistence, sandbox state, and documented model/provider configuration are compatibility-sensitive when they shipped in the latest release or are explicitly supported across processes, runtimes, or machines.
- Interface changes introduced only on the current branch: not a compatibility target. Rewrite them directly.
- Interface changes present on `main` but added after the latest release tag: not a semver breaking change by themselves. Rewrite them directly unless they already back a released or otherwise supported durable format.
- Internal helpers, private types, same-branch tests, fixtures, and examples: update them directly instead of adding adapters.
- Unreleased persisted schema versions on `main` may be renumbered or folded into the next schema before release when intermediate snapshots are intentionally unsupported. Update the declared support set and tests together so the boundary remains explicit.

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

- Prefer deletion or direct replacement over aliases, overloads, shims, feature flags, and dual-write logic when the old shape is unreleased.
- Prefer clearly listed unsupported cases over a partial generalization. An actionable error plus an existing wrapper, typed adapter, or lower-level API is often safer than incomplete emulation of structural types, module targets, or provider behavior.
- Treat a branch-local implementation as disposable. Test coverage proves behavior; it does not make the current architecture worth preserving.
- If review feedback claims a change is breaking, verify it against the latest release tag and actual external impact before accepting the feedback.
- If a change alters behavior or a data format shipped in the latest release, call that out explicitly in the ExecPlan, changeset, and user-facing summary.

## Applying this skill during review

- Establish the requested outcome and compatibility boundary before judging whether the implementation is too narrow or too broad.
- Treat complexity as an actionable finding only when specific added machinery is not needed by the current task, a released contract, supported durable state, or a verified runtime or platform risk. Name that machinery and recommend the smallest safe removal or replacement.
- Do not request abstractions, configuration, dependencies, compatibility work, or extensibility for hypothetical future consumers.
- Classify related comments together before implementing them. If each comment finds a new combination of the same dimensions, treat the abstraction itself as the finding.
- Ask whether each disputed case belongs to the implementation scope contract. A reproducible edge case is not automatically a required supported case.
- Evaluate convergence: a good fix reduces ambiguity and the number of type, runtime, and provider combinations the implementation must infer; a fix that adds inferred combinations without a stated requirement is moving in the wrong direction.
- Review the complete branch diff from the merge base of the intended target branch, or from the latest release tag when it is the compatibility baseline. Do not let small incremental fixes hide a large accumulated design.
- Keep unrelated cleanup and pre-existing problems out of blocking findings. Report them separately only when they are useful to the maintainer.
- Require a broader refactor only when concrete evidence shows that the focused change would otherwise be incorrect, unsafe, incompatible, or materially harder to maintain.

## Pre-handoff effectiveness check

Before declaring the design complete, answer all of these with concrete evidence:

- Can the required behavior be described without naming internal helper types, conditional-type mechanics, or runtime reflection details?
- Does the implementation reuse the nearest existing pipeline rather than maintain a parallel interpretation?
- Can every new abstraction, state field, branch, and package-level change be mapped to the implementation scope contract or a verified compatibility, security, or runtime requirement?
- Is each intentionally unsupported neighboring case rejected before model/tool requests, persisted mutations, or other side effects, with an already-supported alternative identified when one exists?
- Do tests cover the required behavior, behavior matching the nearest released implementation path, and one representative case per intentionally unsupported category without making every constructible type or runtime permutation supported?
- After reviewing the complete diff from the merge base of the intended target branch, would removing any new machinery leave the required behavior intact? If yes, remove it.
- If the latest review comments were applied as a batch, does the new design shrink the future review surface rather than create more combinations?

If any answer is no, continue the strategy review before adding more implementation.

## When to stop and confirm

- The change would alter behavior shipped in the latest release tag.
- The change would modify durable external data or protocol formats that are already released or otherwise supported.
- The correct solution would materially expand beyond the requested outcome or require unrelated architectural work.
- A complexity reset trigger fires and the narrower replacement would change an already released contract rather than branch-local code.
- The user explicitly asked for backward compatibility, deprecation, or migration support.

## Output expectations

When this skill materially affects the implementation approach, state the decision briefly in your reasoning or handoff, for example:

- `Compatibility boundary: latest release tag v0.x.y; branch-local interface rewrite, no shim needed.`
- `Compatibility boundary: latest release tag v0.x.y; unreleased RunState snapshot rewrite, no shim needed.`
- `Compatibility boundary: released RunState schema; preserve compatibility and add migration coverage.`
- `Scope decision: direct change using existing patterns; no new abstraction or adjacent cleanup needed.`
- `Implementation scope contract: support X; preserve Y; reject Z before side effects; use supported alternative W, or none exists.`
- `Complexity reset: repeated type, runtime, or provider combinations show the approach is too broad; redesign from the original requirement instead of adding another branch.`
- `Review decision: the added compatibility path has no released or supported consumer; replace it with the direct implementation.`
