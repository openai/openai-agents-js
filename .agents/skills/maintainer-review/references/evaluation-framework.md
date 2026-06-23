# Maintainer Evaluation Framework

Use this reference when a claim is ambiguous, severity is disputed, or a technically correct PR may not justify permanent maintenance.

## Contents

- [Decision model](#decision-model)
- [Severity](#severity)
- [Evidence strength](#evidence-strength)
- [Issue disposition](#issue-disposition)
- [PR quality and value](#pr-quality-and-value)
- [Documentation threshold](#documentation-threshold)
- [Lifecycle and failure paths](#lifecycle-and-failure-paths)
- [Alternatives](#alternatives)
- [Competing pull requests](#competing-pull-requests)
- [Maintainer comments](#maintainer-comments)
- [Compact report variants](#compact-report-variants)

## Decision Model

Treat validity, severity, and merge-worthiness as separate outputs.

| Dimension | Question | Strong evidence |
| --- | --- | --- |
| Claim validity | Does the exact behavior occur, and is the proposed cause correct? | Reproduction, failing focused test, or complete reachable path |
| Reachability | Can supported realistic inputs reach it? | Public API trace, real configuration, user report, or release comparison |
| Consequence | What fails, and is it silent or recoverable? | Observed output/error/state and downstream effect |
| Breadth | Which packages, runtimes, providers, and versions are affected? | Explicit path and compatibility matrix |
| Frequency | Is it normal, intermittent, or pathological? | Repeats, deterministic preconditions, reports, or telemetry |
| Compatibility | Is released API, package resolution, protocol, or durable state changed? | Latest release comparison and contract inspection |
| Solution fit | Does the fix enforce the invariant at the owning layer? | Equivalent paths remain aligned and alternatives were tested |
| Maintenance cost | What permanent complexity and review burden is added? | New branches/configuration, changed surface, tests, and remaining work |

## Severity

- **Negligible**: no runtime difference, unreachable/unsupported input, cosmetic inconsistency, or harmless edge case. Usually close, document, or decline code complexity.
- **Low**: real but narrow and recoverable behavior with a simple workaround and no data, security, or compatibility risk. Merge only when the fix is small and strengthens an invariant.
- **Moderate**: supported use fails or produces incorrect behavior for a meaningful subset. Prioritize a bounded fix and regression test.
- **High**: common or important use is broken, released compatibility is seriously affected, sensitive data can leak, or persistent corruption is possible. Require urgent strong validation.
- **Critical**: broadly exploitable security impact, severe data loss, or systemic failure requiring coordinated action. Use only with concrete evidence.

Severity is consequence multiplied by realistic reach and frequency, reduced by recoverability. Do not raise it because prose is alarming or lower it because a diff is small.

## Evidence Strength

Before calling a claim confirmed, answer:

- Does the reproduction exercise the same public/internal path?
- Does failure occur on the relevant base, latest release, or target?
- Does the regression test fail without the patch and pass with it?
- Are stale `dist`, wrong worktree/imports, dependency drift, proxies, caches, runtime conditions, unavailable Docker/sandbox, authentication, quota, and service failures excluded?
- Does an equivalent streaming/non-streaming, provider, runtime, resume, or package-export path differ?
- Is behavior prohibited by a real contract or merely surprising?
- For latency, timeout, buffering, backpressure, or cleanup, was observable time or state measured rather than inferred only from mocks?

Use `partially confirmed` when the symptom is real but cause/reach/scope is wrong. Use `unproven` when decisive evidence is missing. Use `contradicted` only when evidence directly disproves the claim.

## Issue Disposition

Choose one:

- **Prioritize**: confirmed moderate-or-higher impact or important invariant with no safe workaround.
- **Accept, low priority**: confirmed low impact and a proportionate fix is plausible.
- **Narrow scope**: valid core, overstated paths or expected behavior.
- **Needs evidence**: plausible but missing a supported reproduction or contract basis.
- **Close**: duplicate, unsupported, unreachable, contradicted, no-op, or not worth permanent complexity.

Ask only for evidence that could change the disposition.

## PR Quality and Value

Assess independently:

1. **Need**: a real problem or user need is demonstrated.
2. **Correctness**: the fix covers the claim and meaningful boundaries.
3. **Placement**: the invariant is enforced once at the owning layer.
4. **Consistency**: equivalent streaming/non-streaming, provider, runtime, serialization, resume, package, and adapter paths stay aligned.
5. **Tests**: a regression test fails on base, passes on head, and asserts the non-happy-path value/state.
6. **Compatibility**: released exports, package conditions, types, protocols, schemas, and error behavior are preserved or intentionally migrated.
7. **Proportionality**: public surface and complexity match impact.
8. **Completion cost**: remaining code, tests, docs, design, and conflict work is bounded enough to justify attention.

A PR can be correct but not merge-worthy because the need is negligible, the real path is unchanged, equivalent paths remain inconsistent, the abstraction costs more than the benefit, or a simpler mechanism exists.

Keep issue severity separate from `Patch risk`. A patch-induced regression, compatibility break, listener/resource leak, or maintenance hazard does not make the underlying issue more severe.

## Documentation Threshold

Make docs merge-blocking only when:

- Existing docs become materially false, unsafe, or misleading.
- Safe/correct use depends on a non-obvious constraint, migration, compatibility boundary, or operational warning.
- Repository policy, accepted scope, or an explicit maintainer decision requires docs in the same PR.
- The feature is practically unusable or undiscoverable without a user-facing entrypoint and generated/API discovery is insufficient.

Keep optional discoverability/completeness non-blocking. Do not downgrade a code verdict solely for optional docs or include optional docs in a required-action paragraph.

## Lifecycle and Failure Paths

Apply this section when a change adds validation, fail-fast behavior, cleanup, retry, interruption, background work, streaming, or concurrency.

- Identify the earliest point where all dynamic inputs required for a correct decision exist.
- List side effects before and after that point: listeners, promises/tasks, streams, sockets, peer connections, processes, files, locks, caches, state, persistence, and telemetry.
- Exercise failure during construction, connection, validation, execution, persistence, and teardown where those phases exist.
- Confirm normal teardown is actually entered. If construction/connect fails, verify explicit cleanup.
- Prefer validation after dynamic configuration is resolved but before avoidable side effects begin.
- Require a regression test for any listener, promise, stream lock, connection, process, file, or state that can remain after failure.

## Alternatives

Test at least one:

- What happens with no code change?
- Can input validation or an existing helper enforce the invariant earlier?
- Can the fix be limited to the supported failing path?
- Would clearer error or documentation prevent misuse without runtime complexity?
- Can a failing test reveal a smaller correct change?
- Is a new public option compensating for an internal ownership problem?
- Can the same result be achieved in the converter, adapter, or state owner instead of every caller?

## Competing Pull Requests

Require an explicit issue link, same reproduction, same violated invariant, or materially overlapping runtime path before grouping candidates.

| Criterion | Question |
| --- | --- |
| Coverage | Whole confirmed issue, useful subset, or adjacent problem? |
| Correctness | Real path and meaningful boundaries? |
| Placement | Owning shared layer? |
| Tests | Base failure reproduced and approaches distinguished? |
| Compatibility | Released APIs, packages, state, protocols, providers, runtimes? |
| Complexity | Permanent branches, abstractions, configuration, coupling? |
| Readiness | Mergeable now or bounded focused work? |
| Reuse | Exact tests or ideas worth transferring? |

Choose one portfolio action:

- **Prefer one PR**
- **Prefer one after focused changes**
- **Combine selectively** into a named destination PR
- **Replace all** with a simpler/coherent implementation
- **Merge none**

Do not issue independent approvals for overlapping candidates. State the action for every active PR.

## Maintainer Comments

Write drafts in English. Produce one when recommending closure, more evidence, focused changes, superseding, or choosing among competing PRs.

Keep it polite, direct, complete, and usually 60-160 words in one to three short paragraphs:

1. Acknowledge the contribution/report.
2. State the decision with decisive technical evidence.
3. Give the exact next action or reconsideration condition.

Do not include internal severity labels, speculate about authorship/intent, repeat the full review, or soften the requested action until it is unclear.

### Close

```text
Thanks for taking the time to investigate this. I traced the reported case through <path or behavior>, and <decisive finding>. In the supported path, <practical result>, so the added complexity is not justified by the demonstrated impact.

I am going to close this <issue/PR>. If you can provide <specific reproduction or evidence that would change the decision>, we can revisit the underlying problem with that narrower scope.
```

### Request Changes

```text
Thanks for the contribution. The underlying issue is valid, and this approach is directionally reasonable. Before we can merge it, please address the following points: <bounded required changes>.

These changes are needed because <contract, lifecycle, compatibility, or test reason>. Once they are covered with a regression test that fails on the base and passes on the updated branch, the PR should be ready for another review.
```

Adapt these templates to evidence. Do not use them as filler.

## Compact Report Variants

### Issue

```markdown
## Verdict

<Real/partial/unproven/contradicted, severity, and disposition.>

## Evidence

- <decisive evidence>
- <scope or uncertainty>

## Recommendation

<Prioritize, accept low priority, narrow, request evidence, or close.>

## Maintainer comment draft

<Include for closure or an evidence request.>
```

### Pull Request

```markdown
## Verdict

<Need, practical impact, and merge-worthiness.>

- Code verdict: <code disposition>
- Repository readiness: <one allowed status; only when useful for a merge-worthy verdict>

## Evidence

- <runtime/code-path result>
- <test/compatibility result>

## Issue impact

- Validity: <claim validity>
- Severity: <underlying issue severity>
- Reach: <realistic reach>

## Patch risk

<Only meaningful patch-induced risk.>

## PR quality

- Solution fit: <assessment>
- Tests: <assessment>
- Remaining effort: <bounded/unbounded and why>

## Recommendation

<Merge, focused changes, simpler replacement, or close.>

## Maintainer comment draft

<Only when closure, evidence, or changes should be requested.>
```

### Competing Pull Requests

```markdown
## Verdict

<Issue validity, severity, and preferred implementation path.>

## Open PR comparison

| PR   | Approach | Correctness | Tests | Compatibility/complexity | Readiness |
| ---- | -------- | ----------- | ----- | ------------------------ | --------- |
| #... | ...      | ...         | ...   | ...                      | ...       |

## Recommendation

<Select one, request focused changes, combine exact pieces, replace all, or merge none.> <State the action for every other active candidate.>

## Maintainer comment drafts

<One draft for each PR that should be closed, changed, or superseded.>
```
