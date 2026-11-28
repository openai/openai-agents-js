---
'@openai/agents-core': patch
---

In long Node.js runs without a session or model input filter, the runner has been batching copies of plain text messages, including user strings with an explicit message type, user messages with one `input_text` part, messages with reordered fields, and helper messages restored from JSON. It has been rebuilding independent, editable model and recovery copies, including reordered text parts and interim assistant statuses, while preserving native validation and ordinary fallback. It has been validating a bounded model-input prefix before ordinary per-item copying when a later record needs native handling.
