---
'@openai/agents-core': patch
---

fix(agents-core): respect tracingDisabled for function tool calls

`buildApprovalRejectionResult` and `runApprovedFunctionTool` called
`withFunctionSpan()` directly, bypassing the `tracingDisabled` /
`getCurrentTrace()` guard that the existing `withToolFunctionSpan` helper
provides. This caused span creation even when `tracingDisabled: true` was
set in `RunConfig`, and could trigger "No existing trace found" errors.

Both functions now use `withToolFunctionSpan`, consistent with
`executeShellActions`, `executeApplyPatchOperations`, and
`executeComputerActions`.
