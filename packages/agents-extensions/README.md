# OpenAI Agents SDK Extensions

This package contains a collection of extension features for the OpenAI Agents SDK and is intended to be used alongside it.

## Installation

```bash
npm install @openai/agents @openai/agents-extensions
```

## OpenTelemetry

Install the OpenTelemetry API and register the optional processor to export the Agents SDK trace hierarchy through your configured OTel SDK.

```ts
import { addTraceProcessor } from '@openai/agents';
import { OpenTelemetryTracingProcessor } from '@openai/agents-extensions/opentelemetry';

addTraceProcessor(new OpenTelemetryTracingProcessor());
```

The processor creates spans for agent, model, handoff, tool, and guardrail operations. It suppresses nested automatic HTTP/fetch instrumentation under model spans by default while retaining instrumentation inside tools. Pass `suppressInstrumentation: false` to disable suppression, `true` to suppress every Agents span, or a callback to choose spans individually. Input and output content is not recorded unless you explicitly opt in with `recordInputs` or `recordOutputs`. Data attached to custom spans requires the separate `recordCustomData` opt-in.

## License

MIT
