# Tracing and Runtime Context

Use this reference for trace/span context, processors, export, flush, shutdown, resume, runtime storage, usage, or sensitive data.

## Context and Lifecycle

- A trace owns spans; the active context determines implicit parentage. Start/end processor callbacks must occur once and restore the previous span stack after success or failure.
- Node can use `AsyncLocalStorage`; browser/workerd shims use a compatible storage contract. Keep context active through awaited callbacks and until streamed results settle, not merely until a function returns the stream object.
- Captured trace context can be restored around a callback. Clearing context must restore the prior ambient value afterward and must not allow new spans on an ended trace.
- A resumed RunState may restore a trace and current agent span, then apply current run overrides. Do not attach a new run to stale ambient context accidentally.

## Processors and Shutdown

- Processors receive trace/span start and end events independently. Completed external trace/span dispatch must not rewrite source timestamps or dispatch no-op objects.
- Batch processors keep exporting after an exporter failure, honor buffer and trigger limits, and serialize flush/shutdown with in-flight export.
- Deduplicate shutdown. `beforeExit` cleanup is one-shot and best-effort; a timeout must not force process exit. Abort active export on timed shutdown and observe late failures.
- Replacing processors must shut down the old set without losing the new provider's lifecycle.

## Data and Export

- `traceIncludeSensitiveData` controls model/tool input and output on spans. Redact exception payloads and formatted rejection text as well as normal fields; hiding a top-level field is insufficient if the original error remains attached.
- Core spans retain provider-neutral usage. The OpenAI exporter maps required token totals and moves supported extra fields into `usage.details` without inventing values.
- Sanitize and byte-limit exported payloads while preserving list positions and useful structured shape. Omit unserializable or getter-throwing values safely.
- Per-run tracing API keys and metadata propagate to child spans but are serialized only when explicitly allowed.

## Review Checklist

1. Test parentage and restoration across await, throw, stream completion, nested runs, and resume.
2. Exercise Node and browser-style context storage.
3. Test exporter error, scheduled retry, flush, shutdown timeout, active abort, and duplicate shutdown.
4. Verify sensitive input/output, errors, metadata, and usage are redacted or mapped at the correct layer.
5. Confirm no-op traces/spans never reach processors or exporters.

## Sources

- `packages/agents-core/src/tracing/context.ts`
- `packages/agents-core/src/tracing/provider.ts`
- `packages/agents-core/src/tracing/processor.ts`
- `packages/agents-core/src/tracing/traces.ts`
- `packages/agents-core/src/tracing/spans.ts`
- `packages/agents-core/src/tracing/createSpans.ts`
- `packages/agents-core/src/runner/tracing.ts`
- `packages/agents-openai/src/openaiTracingExporter.ts`
- `packages/agents-core/test/tracing.test.ts`
- `packages/agents-core/test/runner/tracing.test.ts`
- `packages/agents-openai/test/openaiTracingExporter.test.ts`
- `docs/src/content/docs/guides/tracing.mdx`
