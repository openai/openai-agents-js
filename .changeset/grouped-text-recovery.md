---
'@openai/agents-core': patch
---

In long Node.js runs without a session or model input filter, the runner has been batching copies of plain text messages, including user messages with one `input_text` part. It has been rebuilding independent, editable recovery copies on demand and falling back to individual copies for unexpected native results.
