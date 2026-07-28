# Sensitive logging audit

Use `scripts/inventory-logging.mjs` from the skill directory to inventory every SDK runtime logger call that may carry model data, tool data, thrown values, or other dynamic payloads.

```bash
node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs --summary-only
node .agents/skills/sensitive-logging-audit/scripts/inventory-logging.mjs --format json > /tmp/sensitive-logging.json
```

The inventory is deliberately broader than a vulnerability detector. Static analysis can prove that a dynamic value reaches a log call, but it cannot reliably decide whether an arbitrary value is sensitive. Its `signals` field is only a lexical review hint. Review every dynamic entry and classify it as one of:

- `model`: model requests, responses, Realtime model events, or errors that may include those values.
- `tool`: tool arguments, outputs, tool events, or errors that may include those values.
- `model+tool`: a payload may include both classes.
- `operational`: the value is SDK diagnostic metadata outside the documented model/tool input-output contract.

For model or tool entries, route logging through a policy-aware helper or guard it with `dontLogModelData` / `dontLogToolData`. Do not treat an exception as operational merely because the call site logs only the exception: messages, causes, stacks, schema errors, and arbitrary thrown values may retain sensitive input.

Do not classify a value as sensitive merely because it is dynamic or caller-configurable. Agent names, tool names, model names, session IDs, call IDs, trace/span IDs, response IDs, counts, byte lengths, durations, enum values, booleans, and status codes are operational by default. They require redaction only when concrete source tracing proves that the specific field carries or is derived from model/tool input or output, or a separate documented policy covers it.

Before remediation, require all of the following:

1. An exact source-to-sink trace for the value being logged.
2. Evidence that the source is actual model/tool input or output, or an arbitrary error/detail value from a boundary that processes it.
3. A policy path where the applicable flag is enabled and the value still reaches the sink.
4. A reproducer with a sentinel in the real payload or error field.

Placing a sentinel in a name or identifier is a negative control, not proof of a leak.

## Required validation matrix

For each policy-aware logging path, test both the redacted and diagnostic modes. Use unique sentinel strings and assert against the complete captured logger call, not only one argument.

| Case | Model flag | Tool flag | Sensitive source | Required assertion |
| --- | --- | --- | --- | --- |
| Model redaction | on | off | Actual request/response content or `Error(secret)` from a model boundary | No sentinel appears; diagnostic type is stable |
| Tool redaction | off | on | Actual tool argument/result or `Error(secret)` from a tool boundary | No sentinel appears; diagnostic type is stable |
| Both redacted | on | on | Actual mixed payload or relevant object/string/error | No sentinel appears in any logger call |
| Diagnostic mode | off | off | Ordinary payload-related error | Existing diagnostic detail is preserved |
| Hostile constructor | Applicable flag on | Applicable | Arbitrary thrown value with throwing or controlled `constructor` | Logging does not throw or reveal attacker-controlled data |
| Hostile prototype | Applicable flag on | Applicable | Arbitrary thrown revoked `Proxy` or throwing `getPrototypeOf` trap | Logging does not throw and the caller's fallback continues |
| Supplemental payload | Applicable flag on | Applicable | Safe-looking error plus secret model/tool detail object | Supplemental arguments are omitted |
| Operational negative control | Either | Either | Name, ID, count, status, duration, or byte length | Do not require redaction without separate evidence |

Also exercise the observable caller behavior after logging. Error handling is not correct if redaction prevents a fallback result, event emission, cleanup, or rejection from completing.

## Review procedure

1. Run the full inventory against `packages/*/src`.
2. Review raw `console.*` calls first because they bypass `Logger` policy flags.
3. Review caught-value calls next; arbitrary thrown values are attacker-controlled at JavaScript boundaries.
4. Review every remaining dynamic call and record its model/tool/operational classification in the audit notes. Treat lexical signals as navigation aids, not evidence.
5. Trace sensitive values through formatting helpers such as template literals, `JSON.stringify`, schema errors, and `toErrorMessage`; formatting is not redaction.
6. Verify both streaming and non-streaming paths, Realtime and regular runs, tool approval rejection, MCP/tool adapters, session callbacks, tracing/export failures, and cleanup paths when they can carry user data.
7. Add the focused matrix above for every confirmed sensitive path that is changed. Do not create identifier-redaction tests that broaden the flag contract.
8. Re-run the inventory after the fix and compare fingerprints. Every added or changed dynamic call requires classification before merge.

The audit supports a strong completeness claim about reviewed log sinks, not automatic information-flow proof or a vulnerability count. A future CI gate can store reviewed fingerprints and fail on new or changed dynamic calls; the JSON output is stable enough to build that ledger without tying policy decisions to line numbers.
