---
name: implementation-final-review
description: Perform a risk-tiered zero-base final review for implementations before completion. Use only when the user explicitly invokes $implementation-final-review or repository instructions authorize automatic invocation after implementation. Audit the complete merge-base diff for requirement fit, contract-surface coverage, await-boundary and lifecycle gaps, released compatibility, package and runtime boundaries, security and persistence, unnecessary complexity, generated types, and adversarial coverage; use base-plus-delta evidence bundles and fresh-context concurrent reviewers for elevated-risk changes, overlap non-mutating final repository verification with reviewer waits on the same frozen fingerprint, preserve justified clean evidence for byte-identical semantic components, close repeated root causes repository-wide, and escalate non-convergence after a task-global maximum of six review rounds.
---

# Implementation Final Review

Treat implementation and final review as separate phases. Reconstruct the change from the original requirement and complete task-owned diff. Do not defend branch-local design because it is already implemented or tested.

## Non-negotiable guarantees

- Review the exact final task content, including committed, staged, unstaged, and task-owned untracked deliverables.
- Use the merge-base three-dot diff for patch ownership and the latest release tag separately for released compatibility.
- Require independent review. A same-context self-review cannot satisfy a clean gate.
- Freeze task-owned content while reviewers inspect a fingerprint.
- Report only concrete, patch-scoped findings supported by requirements, released behavior, a durable boundary, explicit maintainer intent, user reliance, or a baseline regression.
- Never weaken final repository verification. Component-aware review invalidation reduces repeated review, not required build or test gates.

## Workflow

### 1. Prepare once

1. Finish the initial implementation, required changeset, formatting, and focused tests.
2. Re-read the original request and record the four-part implementation scope contract: required behavior; compatibility requirements; intentionally unsupported cases and failure behavior; supported alternative or `none`. In `openai-agents-js`, invoke `$implementation-strategy` once here.
3. Resolve the intended target, explicit merge base, and latest release tag when released compatibility matters. If target and `HEAD` diverge, use their common merge base and review `merge-base...HEAD`.
4. Classify review risk:
   - **Normal:** no changed concurrency, cancellation, security, trust, persistence, durable state, released compatibility, package/runtime export boundary, protocol ownership, or cross-provider lifecycle.
   - **Elevated:** any of those boundaries changes, a major dependency migration crosses runtime behavior, or an earlier round produced P0/P1.
5. Run a pre-review validation sized to the affected surface:
   - Normal: focused tests plus the affected package build/type check.
   - Elevated or cross-cutting: the affected package's complete unit suite plus its build/type/dist checks when available.
   - Do not run the complete repository verification merely to enter this gate.
6. Build the pre-dispatch evidence required by the changed boundary:
   - For every changed public symbol, configuration field, event, serialized field, wire value, or documented caller-visible behavior, create a contract-surface inventory: producers and constructors; every consumer, forwarding branch, and adapter; default, missing, and invalid-value behavior; package exports and generated declarations; adjacent docs and examples; and caller-visible tests. Search adjacent contract surfaces even when they are absent from the diff. A required docs, example, export, adapter, or declaration update is a missing task deliverable, not out of scope merely because it is not yet in the manifest.
   - For concurrency, cancellation, reentrancy, shared lifecycle state, or a check followed by an await before a side effect, create an await-boundary matrix. For each relevant operation, record the state snapshot, await point, events and operations that may run while suspended, durable or monotonic evidence retained, revalidation before each side effect, and resulting cancel, feedback, persistence, or cleanup action. Include source completion, a newer operation active with known or unknown identity, a newer operation that starts and completes while suspended, and failure or cancellation of the awaited action when those states are supported. If correctness depends on whether something ever happened, current active state is insufficient unless serialization proves it cannot be lost; require monotonic identity, generation, tombstone, or equivalent durable evidence.
   - For persistence, protocol, or security changes, create the analogous authority/data-flow inventory from input through validation, storage, output, exceptions, logs, telemetry, retry/replay, and cleanup. Treat these as mechanical coverage artifacts, not implementation conclusions. Reviewers validate them independently against the complete diff and surrounding source.
7. Create one canonical pathspec manifest containing every task-owned deliverable, including both sides of renames and required release metadata. Exclude ignored or local-only operational artifacts such as private ExecPlans, review ledgers, generated review bundles, logs, and scratch output when they are not part of the deliverable. Write one literal Git pathspec per nonempty line; do not add comments or trim intentional whitespace. Treat empty CLI pathspecs, unreadable manifests, invalid repositories or bases, and Git failures as errors rather than broadening scope. Reuse the same manifest for every reviewer and fingerprint command.
8. Partition deliverables into semantic review components. For a small single-boundary change, `runtime`, `tests-examples`, and `release-metadata` may be sufficient. For multi-boundary work, use stable behavior-owner names such as `public-api`, `session-persistence`, `provider-adapters`, or another task-specific boundary. A file belongs to exactly one component; do not infer component ownership automatically from path spelling. Record a combined fingerprint and one fingerprint per component with `scripts/review_state.py --pathspec-file task.paths --component-pathspec-file NAME=NAME.paths ...`. A byte-identical component with prior clean evidence is only a clean candidate, not automatically reusable clean credit. Preserve its clean credit only after proving that the current delta does not change its required behavior, assertions, or boundary with changed components. If that proof is missing or ambiguous, invalidate the candidate.
9. Read the complete task-owned diff and record the initial complexity delta: runtime lines changed, new state fields, new synchronization or ownership mechanisms, affected subsystems, and caller-visible test permutations.
10. Run the baseline-reset gate once before the first review:

- Describe required behavior without branch-local helper or state names.
- Identify the nearest released/base pipeline that owns it.
- Compare the current patch with a narrow change from the base implementation.
- Treat unreleased task machinery and tests as disposable.
- Choose the narrower design unless concrete contract evidence requires more.

11. Prepare one self-contained reviewer brief per round using `references/reviewer-brief.md`. Keep immutable task evidence in one base packet and current-fingerprint changes, focused results, and root-cause closure evidence in one round delta. Do not append historical round transcripts, superseded fingerprints, or every prior verification result to reviewer packets; keep those only in the coordinator ledger. Prefer `scripts/prepare_review_round.py` to combine the base packet, round delta, manifests, current fingerprints, tracked diff, wide-context diff, complete task-owned untracked content, byte-identical prior-clean candidates, and the exact reviewer instructions and result schema. Populate every template field or mark it explicitly `none` or `not applicable`; do not dispatch an incomplete packet. Give each reviewer one ready-to-run fingerprint revalidation command and reuse the same requirement and shared factual body; only the specialty assignment may differ. Do not ask reviewers to rediscover this workflow skill, `$implementation-strategy`, memory, the release tag, manifest paths, helper location, or verification history. A reviewer may reopen primary source or released evidence when supplied evidence is inconsistent, appears wrong, or leaves a decision-relevant ambiguity, but reopening is not a substitute for missing mandatory packet contents and routine context reconstruction belongs to the implementer.

Example bundle preparation:

```bash
python3 .agents/skills/implementation-final-review/scripts/prepare_review_round.py \
  --repo "$PWD" --base "$BASE_COMMIT" \
  --pathspec-file plans/review/task.paths \
  --component-pathspec-file public-api=plans/review/public-api.paths \
  --component-pathspec-file provider-adapters=plans/review/provider-adapters.paths \
  --base-packet plans/review/base-packet.md \
  --round-delta plans/review/round-2-delta.md \
  --prior-clean-state plans/review/round-1-clean.json \
  --output-dir plans/review/round-2
```

### 2. Review and verify one frozen fingerprint

1. Start review round 1 and freeze every task-owned deliverable. Do not edit, format, regenerate, stage, or otherwise change it until all reviewers for the round finish or are canceled.
2. Choose reviewers:
   - Normal: one independent reviewer covering every selected dimension.
   - Elevated: two independent reviewers concurrently on the same combined fingerprint. Assign non-overlapping primary specialties, while requiring both to report any concrete blocker they encounter. Typical split: released compatibility/session/pagination/lifecycle versus protocol/cache/security/package boundaries.
   - A broad multi-boundary normal-risk diff may also use two concurrent specialists when that is likely to collect independent root causes in one round.
3. Spawn every reviewer with `fork_turns:"none"` and give it only the shared factual packet plus its specialty assignment. Never inherit the implementer's conversation or prior reviewer context. Do not provide implementer conclusions, suspected bugs, previous findings, or intended fixes.
4. Require exactly one read-only review round. Reviewers must not edit or stage files, recursively invoke this skill, spawn reviewers, or run broad repository verification. Permit only focused, demonstrably non-mutating probes needed for a decision-relevant uncertainty.
5. Require each reviewer to complete all assigned dimensions even after finding a blocker. For every changed public entry point and source of shared state, demand a concrete account rather than a generic checklist assertion.
6. Immediately after reviewer dispatch, start every eligible final repository gate against the same frozen fingerprint instead of waiting for a clean verdict. In `openai-agents-js`, this normally means the read-only validation phase of `$changeset-validation` when the required changeset already exists and `$code-change-verification` for eligible changes. Run them concurrently with reviewer work when the host permits it.
   - During an iterative review round, use the narrowest of three evidence-based test choices: for changes unrelated to every owner in `helpers/vitest/reviewTestProfile.ts`, run `pnpm test:review`; for a leaf subsystem change, run `pnpm test:review` plus that subsystem's complete test file or directory with `pnpm exec vitest run <path>`; for cross-cutting core changes, shared test-infrastructure changes, or an uncertain boundary, run `pnpm test`. Do not use `pnpm test <path>` for focused execution: the root script chains another command and appends path arguments to the wrong command. Inspect the current review-optional owners before choosing. The reduced check earns no final-gate credit; the exact clean-reviewed fingerprint must still pass the complete `$code-change-verification` stack, including `pnpm test`.
   - Before dispatch, record each planned command and establish that it does not edit, format, regenerate, stage, or create any task-owned deliverable. Dependency trees, caches, ignored coverage, logs, and build outputs are allowed only when they are outside the canonical manifest and cannot affect what reviewers read.
   - Complete any known mutating formatter, generator, changeset creation, or similar gate before freezing the round. If a required gate cannot be shown non-mutating, defer it until review is clean rather than risking the frozen evidence.
   - Record the combined and component fingerprints immediately before the gate starts and after it exits. A concurrent pass earns final-gate credit only when both fingerprints match the reviewed fingerprint exactly.
   - Keep `$pr-draft-summary` deferred until both clean review evidence and required final-gate evidence apply to the final fingerprint.
7. Wait for all concurrent reviewers before editing. Use one multi-target wait or the platform's first-completion wait when available; when using `wait_agent`, prefer a 180000-300000 millisecond timeout because mailbox completion ends the wait early, and do not poll reviewers separately. Do not interleave `list_agents` without an error or inconsistent state, ask for progress, or make reviewers repeat shared evidence collection. Let eligible verification continue concurrently. If a reviewer reports an actionable finding while verification is still running, cancel or stop the obsolete verification when practical, then wait for the complete reviewer batch before editing. Diagnostics from an obsolete pass may guide repair, but the pass cannot satisfy completion after a semantic edit.
8. Recompute combined and component fingerprints after reviewers and any concurrent gates finish. If combined content changed while review was running, discard all reviewer output and concurrent gate credit for that round; do not count the round. If only repository bookkeeping or excluded operational artifacts changed and component content is identical, record the transition and accept the review and gate evidence. Any ambiguity invalidates the round.
9. Apply a packet-and-output acceptance gate before counting findings or clean credit. Verify that every mandatory reviewer-brief field was populated or explicitly marked `none` or `not applicable`; missing packet evidence cannot be reconstructed by the reviewer and earns no clean credit. Require the structured JSON result defined in `references/reviewer-brief.md`, including verdict, exact reviewed fingerprints, checked and unchecked inventory IDs, high-risk dimensions, focused probes, remaining uncertainty, sibling-instance scan, and findings. A bare `clean`, generic checklist, malformed result, or response that leaves assigned rows unchecked is incomplete and earns no clean credit. Request only the missing coverage on the same frozen fingerprint, at most once; a second incomplete response invalidates that review rather than starting an open-ended clarification loop. For two specialists, combine their declared coverage and reject the round if any inventory row or selected high-risk dimension remains unreviewed.

### 3. Classify and repair one batch

Classify each finding before editing:

- required-behavior defect;
- released compatibility or durable-boundary defect;
- missing failure-path or adversarial coverage;
- unsupported neighboring case that should fail earlier;
- unnecessary machinery or duplicated source of truth;
- unrelated or unsupported suggestion to reject.

Record the support basis, root-cause group, severity, and smallest safe correction. Reject unsupported suggestions rather than expanding the contract.

Before editing:

- Reinvoke `$implementation-strategy` only if the finding changes the scope contract, compatibility boundary, supported behavior, state ownership, protocol path, abstraction count, or caller-visible test permutations.
- If none changes, record `scope contract unchanged` and repair directly without rereading the full strategy workflow.
- If a second related finding would add another condition, state, resolver step, protocol hop, ownership mode, or test permutation to the same abstraction, stop local patching and perform the complexity reset below.
- Update the complete relevant inventory or matrix with the discovered transition or surface and solve the root cause across all populated rows; do not patch only the reported branch or interleaving.
- Before another review round after a repeated root cause, complete a root-cause closure record: repository-wide search commands and complete hits; every affected producer, consumer, adapter, persistence path, and test; a `retain`, `replace`, or `delete` disposition for every hit; and a focused test or static assertion that fails when the duplicate decision path returns. Do not dispatch reviewers while any hit lacks a disposition.

Fix every actionable finding in one batch. Prefer caller-visible regression coverage. Run the affected package's focused verification, update the component fingerprints, and start a fresh review round. Previous reviewers may clarify evidence but cannot count as independent clean reviewers for edited content.

### 4. Converge without serial clean waits

- Normal succeeds when one independent reviewer returns clean on the exact final combined fingerprint.
- Elevated succeeds when two independent reviewers return clean on the exact same combined fingerprint. Run them concurrently; sequential ordering provides no additional evidence while content is frozen.
- If one elevated reviewer is clean and the other reports a finding, the clean result does not carry across the semantic edit. Fix the batch and run a fresh concurrent pair.
- After three finding-bearing rounds, rerun the baseline-reset gate before another local fix.
- If the same root-cause group produces another P0/P1 after a complexity reset, replace task-owned branch-local machinery with the narrowest coherent base-derived implementation, then run one specialist concurrent pair.
- If that replacement produces the same root-cause P0/P1, or severity and complexity do not fall after three finding-bearing rounds, escalate instead of continuing local patching.
- Escalate early if four rounds complete without a shrinking or stable diff and falling finding severity.
- Stop after six valid review rounds for the original task requirement and task-owned manifest. This counter is task-global: pauses, resumed turns, context compaction, renamed `fresh` cycles, documentation splits, commits with identical content, and reviewer replacement do not reset it. Reset the counter only when the user materially changes the requirement into a separate task with a new manifest and scope contract. Six rounds is an absolute cap, not a target. Do not declare completion; report remaining blockers, recurring root causes, complexity growth, attempts, and user decision points.

Maintain one compact ledger only at meaningful transitions:

`Round | semantic component fingerprints | reviewers | root causes | closure evidence | highest severity | complexity delta | action | clean candidates and accepted clean set | inspection calls | preparation time`

Do not emit repeated substantive waiting updates when reviewer state and repository content are unchanged. If the host requires a periodic heartbeat, keep it to one line and send it no more often than required.

### 5. Accept or rerun final repository gates once the review is clean

In `openai-agents-js`, require `$changeset-validation` when `packages/` or `.changeset/` changed and `$code-change-verification` for runtime, test, example, or build/test changes. Do not wait until this section to start them when step 6 permits safe overlap.

A speculative final-gate pass from the reviewer wait satisfies this gate only when every required command passed, its before-and-after component fingerprints match the exact clean-reviewed fingerprint, and it did not change task-owned content. Run any gate that was ineligible for overlap now. Only after both review and verification evidence apply to the final fingerprint, invoke `$pr-draft-summary` last.

If reviewers report a finding and repair changes semantic content, discard every speculative final-gate result from the prior fingerprint and rerun every mandatory repository gate on the new content. Reuse caches and diagnostics when safe, but never carry pass credit across a semantic edit.

If a final gate changes deliverable content, classify the delta before invalidating review evidence:

- **Runtime, public API, behavior-impacting docs, or contract change:** invalidate the combined clean set, rerun the applicable pre-review validation, and restart review with fresh reviewers. Then rerun every required final gate.
- **Tests/examples only:** preserve clean runtime evidence only when the runtime component fingerprint is identical and the delta does not change required behavior, compatibility, assertions about runtime behavior, or the scope contract. Run focused verification for the delta and one fresh independent delta review covering test correctness, caller-visible coverage, accidental contract expansion, and the changed component's boundary with runtime. Record a new combined fingerprint. Then rerun the repository gates required by repository policy.
- **Release metadata only:** preserve runtime and test evidence when their component fingerprints are identical. Revalidate the metadata and independently review any changed behavioral claim. Then rerun applicable final gates.
- **Operational artifact only:** exclude it from deliverable manifests and do not invalidate review evidence.

Completion requires that the final combined fingerprint is exactly composed of component fingerprints with applicable clean or delta-review evidence and that all mandatory repository gates pass on that final content.

## Independent reviewer rules

- Use a fresh context that did not implement the fingerprinted content.
- Require explicit merge-base calculation or verification; never present a two-dot target-to-head diff as the patch.
- Share raw verification commands and results, not implementer conclusions.
- Do not reveal findings or conclusions from earlier rounds.
- Concurrent reviewers receive the same fingerprint and raw context, but different primary specialties. They must not communicate during the round.
- Reviewers inspect code and tests, then run only focused non-mutating probes. They do not inspect memory, rediscover workflow skills, rerun implementation strategy, search for the fingerprint helper, or rediscover the release tag unless the shared packet is missing or inconsistent. The implementer owns edits, loop control, and final verification.
- Batch source inspection. Target at most 12 shell inspection calls for one review, without treating this as a hard cap. Before exceeding the target, identify the exact missing packet evidence or decision-relevant uncertainty that requires more source reads, and include it in the structured result. A packet that repeatedly requires more than 12 calls should be repaired before the next round.
- A self-review is best effort only and cannot satisfy a clean gate. Report reviewer unavailability instead of silently weakening the requirement.

## Review dimensions

Select dimensions from the affected boundaries. In `openai-agents-js`, start at `.agents/references/README.md` and read only references for those boundaries.

### Requirement and complexity

- Verify the smallest required caller-visible behavior and representative early failure for unsupported categories.
- Map every new abstraction, state field, branch, dependency, and cross-module change to a requirement, released contract, durable boundary, or verified risk.
- Check that tests do not turn implementation permutations into public contract.
- Require baseline evidence before treating merely constructible, repeated, concurrent, wrapped, or third-party shapes as supported.
- Account for every contract-surface inventory row, including specialized, default, missing-value, invalid-value, forwarding, package-export, generated-declaration, docs, and example paths that apply.

### Compatibility and package identity

- Compare released signatures, field order, imports, names, serialized values, configuration, and wire behavior.
- Distinguish unreleased branch-local machinery from released or durable boundaries.
- Trace export maps, convenience re-exports, ESM/CJS/types, browser/Node/workerd shims, declaration output, optional dependencies, and import side effects when affected.
- Preserve exact caller-visible identity and spelling unless transformation is required.

### Lifecycle and failures

- Trace acquisition through success, partial failure, cancellation, retry, replacement, and cleanup.
- For shared lifecycle state, build an operation-state matrix covering relevant sequential and overlapping public mutations and identify the serialization or linearization point.
- Check repeated cancellation, reconnect, cleanup failure, primary-exception preservation, and the final survivor invariant.
- Compare streaming/non-streaming, initial/resumed, direct/wrapped, and provider-specific paths only when the contract crosses them.
- Audit every check-await-side-effect sequence. Require revalidation or prove manager-owned serialization before cancellation, feedback, persistence, or cleanup.
- Distinguish current state from historical evidence. If a stale-result guarantee depends on whether a newer operation ever started, an active pointer that can return to `undefined` or `null` cannot prove absence; require monotonic evidence unless the operation is serialized.

### Security, trust, persistence, and protocol

- Trace caller-controlled data through logs, errors, causes, telemetry, model-visible output, and persistence.
- Treat serialized or remote state as authority only at an explicit supported trust boundary.
- Check fail-closed malformed-input behavior without retaining or returning secrets.
- Verify protocol capability ownership, pagination termination, cache ownership, retry/replay safety, wire validation, and tool/call identity when affected.

### Tests and generated surfaces

- Prefer public-boundary adversarial tests and controlled interleavings.
- Test required behavior, the nearest supported alternative, and one representative unsupported input per category.
- Import through consumer entry points when package behavior changes.
- Check generated declarations or dist evidence for public type changes; runtime tests alone do not prove the published surface.

## Complexity reset

1. Stop addressing findings individually.
2. Group all findings by root cause and restate the original behavior.
3. Compare the complete diff with the merge base or release boundary.
4. Remove task-owned machinery without concrete contract or risk support.
5. Reuse the nearest existing source-of-truth pipeline.
6. Reject unsupported behavior before side effects and name an existing supported alternative when available.
7. Rebuild tests around caller-visible invariants and representative negative categories.
8. Produce the root-cause closure record: complete repository hits, affected entry points and lifecycle paths, a `retain`/`replace`/`delete` disposition for every hit, and a focused invariant probe that detects reintroduction.
9. Compare replacement complexity with both the previous round and merge base. Renaming or redistributing a growing state machine is not a reset.

## Review output

Lead with `clean`, `findings require fixes`, or `complexity reset required`.

For each finding include priority, exact file/line or symbol, concrete failure and user-visible consequence, support basis with baseline evidence when needed, and the smallest safe correction. If clean, report the exact reviewed fingerprints, assigned inventory rows and high-risk dimensions checked, focused probes or `none`, and remaining uncertainty or `none`; a bare verdict is incomplete.
