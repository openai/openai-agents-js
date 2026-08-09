# Independent Reviewer Brief

Use this template to prepare one self-contained, factual packet per fingerprint round. Fill every field or mark it explicitly `none` or `not applicable`; do not dispatch an incomplete packet. Fill it once, reuse the shared body byte-for-byte for every reviewer, and vary only the final specialty assignment. Do not include implementer conclusions, suspected bugs, prior findings, or intended fixes.

## Shared evidence

- Original requirement:
- Implementation scope contract:
  - Required behavior:
  - Compatibility requirements:
  - Intentionally unsupported cases and failure behavior:
  - Supported alternative or `none`:
- Intended target:
- Resolved merge base:
- HEAD:
- Latest release boundary when relevant:
- Risk tier and reason:
- Canonical task manifest:
- Component manifests:
- Semantic component ownership and changed boundaries:
- Combined, component, and repository fingerprints:
- Byte-identical prior-clean candidates and why each is or is not reusable:
- Exact fingerprint revalidation command:
- Raw repository status:
- Complete three-dot diff command:
- Focused preflight commands and results:
- Eligible concurrent final-gate commands and non-mutation basis:
- Gates deferred because they may mutate task-owned content, or `none`:
- Selected architecture references or exact relevant excerpts:
- Root-cause closure record for repeated findings, or `not applicable`:
- Review preparation time and expected inspection-call budget:

## Contract-surface inventory

Use one row per changed public symbol, configuration field, event, serialized field, wire value, or documented behavior.

`surface | producers/constructors | consumers/forwarding branches/adapters | default/missing/invalid behavior | package exports/generated declarations | adjacent docs/examples | caller-visible tests`

Include adjacent surfaces found outside the current diff. If a required update is absent, add it to the task manifest before freezing the review.

## Await-boundary or authority inventory

For concurrency, cancellation, reentrancy, or lifecycle state use:

`operation | state snapshot | await point | events/operations possible while suspended | monotonic evidence retained | revalidation | side effects/invariant`

Populate supported states including source completion, a newer active operation with known or unknown identity, a newer operation started then completed, and awaited-action failure or cancellation. If the contract depends on whether something ever happened, identify the monotonic evidence or serialization proof.

For protocol, security, or persistence instead use:

`input/authority | validation | in-memory state | persisted/serialized state | retry/replay | output | exception/log/telemetry exposure | cleanup/revocation`

## Reviewer instructions

Perform exactly one read-only review round on the frozen fingerprint. First run the supplied revalidation command and verify the supplied merge base when applicable. Then inspect the complete raw diff, wide-context bundle, surrounding source when needed, tests, and supplied references. Validate every assigned inventory row rather than trusting the implementer. You may report blockers outside your specialty.

Do not edit or stage files, recursively invoke the review workflow, spawn another reviewer, run broad repository verification, inspect memory, rediscover workflow skills, rerun implementation strategy, search for the fingerprint helper, or rediscover the release tag. The parent-prepared implementation scope contract is the strategy result for this review; validate it against evidence instead of regenerating it. If any mandatory packet field is neither populated nor explicitly marked `none` or `not applicable`, report the missing field and do not return a creditable clean verdict. Reopen primary source or released evidence only when supplied evidence is inconsistent or leaves a decision-relevant uncertainty; do not use reopening to replace missing packet contents. Run only focused non-mutating probes needed to resolve such uncertainty.

Batch related source reads and target no more than 12 shell inspection calls. This is not a hard cap. Before exceeding it, identify the exact missing packet evidence or decision-relevant uncertainty that requires further inspection, then record that reason in `inspection_budget`.

Return exactly one JSON object with this shape, using empty arrays instead of prose such as `none`:

```json
{
  "verdict": "clean | findings require fixes | complexity reset required",
  "fingerprints": {
    "combined": "sha256",
    "components": { "component-name": "sha256" }
  },
  "checked_inventory_ids": ["C1", "A1"],
  "unchecked_inventory_ids": [],
  "high_risk_dimensions": ["released compatibility"],
  "probes": ["command and result"],
  "remaining_uncertainty": [],
  "inspection_budget": {
    "shell_calls": 8,
    "exceeded_reason": null
  },
  "sibling_instance_scan": {
    "commands": ["rg command"],
    "complete_hits": ["file:symbol disposition"],
    "unresolved_hits": []
  },
  "findings": [
    {
      "priority": "P1",
      "location": "file:line or symbol",
      "failure": "concrete failure and user-visible consequence",
      "support": "requirement, released behavior, or durable boundary",
      "smallest_safe_correction": "focused correction"
    }
  ]
}
```

A bare `clean` or generic checklist is incomplete. A malformed JSON object or nonempty `unchecked_inventory_ids` also earns no clean credit.

## Specialty assignment

- Primary dimensions:
- Required inventory rows:
- Complementary reviewer assignment, if any:
