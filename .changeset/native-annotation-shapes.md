---
'@openai/agents-codex': patch
---

Native tracing has been accepting small JSON containers and metadata strings within the aggregate byte budgets. Processor and OTLP delivery have been preserving the full metadata, while generic limits and actual queue-byte charging have been remaining unchanged.
