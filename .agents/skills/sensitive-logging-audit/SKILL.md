---
name: sensitive-logging-audit
description: Audit and fix model or tool input/output exposure through runtime logging in openai-agents-js. Use when reviewing logger or console calls, checking OPENAI_AGENTS_DONT_LOG_MODEL_DATA or OPENAI_AGENTS_DONT_LOG_TOOL_DATA coverage, investigating exceptions or payloads that may reveal model inputs and outputs, tool arguments and results, Realtime events, MCP data, session history, or arbitrary thrown values, while distinguishing those payloads from operational names, identifiers, counts, and statuses.
---

# Sensitive Logging Audit

## Objective

Inventory every runtime log sink, classify each dynamic value against the documented logger-flag contract, and fix every demonstrated model/tool input/output leak in scope. If no leak is demonstrated, report that result and leave runtime code unchanged.

Do not claim automated taint analysis. The inventory proves sink coverage and provides lexical review hints; it does not classify a value as sensitive. Source-to-sink classification still requires code tracing.

The two logger flags have a narrow contract:

- `dontLogModelData` suppresses LLM inputs and outputs.
- `dontLogToolData` suppresses tool inputs and outputs.

They are not general "hide every caller-configurable string" flags. Agent names, tool names, model names, session IDs, call IDs, trace/span IDs, response IDs, counts, byte lengths, durations, enum values, booleans, status codes, and similar operational metadata are not sensitive under this contract merely because an application can choose their values. Treat one of these as sensitive only when concrete source tracing proves that the field carries or is derived from actual model/tool input or output, or when a separate documented policy explicitly covers it.

## Workflow

### 1. Establish the baseline

- Work in the user's current checkout and branch. Preserve unrelated changes.
- Record `git status --short --branch` and the current commit.
- Read the logging policy in `packages/agents-core/src/config.ts` and helpers in `packages/agents-core/src/logger.ts` before judging call sites.
- Read the public logging documentation and the latest released version of that documentation. Use their stated model/tool input-output boundary as the compatibility contract.
- Treat model/tool errors as potentially sensitive: messages, causes, stacks, schema errors, and arbitrary thrown values can retain user data.

Run the deterministic inventory from the repository root:

```bash
node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs --format json > /tmp/sensitive-logging-before.json
node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs --summary-only
```

Run its tests before relying on the report:

```bash
node --test .agents/skills/sensitive-logging-audit/scripts/inventory-logging.test.mjs
```

### 2. Classify every dynamic sink

Review the complete JSON ledger. Do not stop after the first confirmed leak. Prioritize:

1. Raw `console.*` calls, because they bypass `Logger` policy.
2. Calls that log a caught value.
3. Calls with supplemental payloads.
4. Dynamic messages using interpolation, `JSON.stringify`, schema formatting, or `toErrorMessage`.
5. Model, tool, Realtime, MCP, session, tracing, and cleanup boundaries.

Inventory `signals` are lexical prioritization hints only. A `tool`, `model`, or `payload` hint is not a finding and does not override source tracing.

Assign one disposition to every dynamic entry:

- `model`: may contain model requests, responses, Realtime model events, or derived values.
- `tool`: may contain tool arguments, outputs, tool events, MCP payloads, or derived values.
- `model+tool`: may contain either class.
- `operational`: contains SDK diagnostics or metadata outside the documented model/tool input-output contract.
- `uncertain`: source tracing is incomplete; investigate before deciding.

Record file, line, fingerprint, disposition, evidence, and action in the task notes. A variable name or log message is not sufficient evidence. Trace producers, formatters, callbacks, and thrown-value ownership.

Use this decision gate before calling any candidate a leak:

1. Identify the exact value reaching the sink, not only a keyword in the log statement.
2. Show that the value can contain actual model input/output, tool input/output, or an arbitrary error/detail object from a boundary that processes that data.
3. Show that the applicable suppression flag can be enabled while that value is still formatted or logged.
4. Reproduce the exposure with a sentinel placed in the real payload field or error path.

If any step is missing, keep the candidate `uncertain` or classify it as `operational`; do not modify runtime code.

Do not prove a leak by putting a sentinel into an operational name or identifier. That only proves that the field is logged, not that it falls under the model/tool-data contract. Caller configurability, by itself, is not sensitivity evidence.

### 3. Fix demonstrated leaks

Before changing runtime code, use `$implementation-strategy` and follow the repository's compatibility decision. Then implement the narrowest shared-boundary fix.

- Prefer `logModelActionError` or `logToolActionError` for error-level paths.
- For debug or warning paths, apply the relevant logger flag before formatting or inspecting sensitive values. Add a shared helper only when multiple paths need the same semantics.
- For `model+tool`, redact when either relevant policy disables data logging.
- Preserve existing diagnostic details when the applicable logging flags allow them.
- In redacted mode, emit only a fixed message and a safe fixed type. Do not inspect `error.constructor`, stack, message, cause, proxy properties, or supplemental payloads.
- Keep logging failure from changing caller behavior. Fallback results, event emission, cleanup, rejection, and cancellation must still complete.
- Preserve operational metadata when suppressing model/tool payloads. Do not add flag branches around names, identifiers, counts, statuses, or timing data without concrete evidence that the specific value carries protected payload content.
- Apply hostile-object tests only to values whose public or internal boundary accepts arbitrary thrown or callback-supplied values. Do not invent hostile `toString`, proxy, or constructor cases for ordinary SDK-owned metadata objects.

When a candidate is not a leak, keep the code unchanged and record the concrete source-to-sink reason.

### 4. Add adversarial regressions

Read [the redaction validation matrix](references/redaction-validation.md) and cover every changed sensitive path. At minimum test:

- redacted and diagnostic modes;
- model-only, tool-only, and both-flags combinations as applicable;
- unique sentinel strings placed in actual model/tool inputs, outputs, or relevant error/detail values and checked across the full captured logger call;
- `Error`, string, object, supplemental payload, constructor override, revoked `Proxy`, and throwing `getPrototypeOf` cases where arbitrary thrown values are accepted;
- observable caller behavior after logging.

Prefer focused unit tests at the real caller boundary. Helper-only tests do not prove all call sites use the helper.

Do not add tests that expect agent names, tool names, model names, or IDs to disappear solely because a model/tool-data flag is enabled. Such a test silently broadens the public contract instead of validating it.

### 5. Re-audit the whole tree

Run the inventory again:

```bash
node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs --format json > /tmp/sensitive-logging-after.json
```

Compare the before/after findings by fingerprint and inspect every new or changed dynamic call. Revisit the full candidate list, not only edited files. The completion report must state:

- total and dynamic sink counts;
- all confirmed leaks fixed, or an explicit statement that none were found;
- all retained candidates and their evidence-backed dispositions;
- any unresolved candidate and why it remains unresolved.

Do not report completion while a demonstrated leak remains in scope.

### 6. Run repository close-out gates

- If `packages/` changed, use `$changeset-validation` and ensure every affected package has an appropriate changeset.
- For runtime code, tests, scripts, or build/test behavior, use `$code-change-verification` and rerun the full stack after the final fix.
- Use `$pr-draft-summary` after all edits and verification.
- Stop after local changes and verification unless the user explicitly requests a remote action in the same turn.

## Reporting

Lead with whether any real model/tool payload leaks were found. Separate confirmed leaks from conservative review candidates and operational metadata. Include the inventory counts, affected paths, adversarial cases, verification results, and remaining uncertainty. Do not present candidate counts as vulnerability counts, and do not equate a clean inventory shape with proof that all dynamic values are non-sensitive.
