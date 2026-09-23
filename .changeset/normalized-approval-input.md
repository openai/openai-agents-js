---
'@openai/agents-core': minor
'@openai/agents-realtime': minor
---

fix: bind conditional tool approvals to isolated normalized execution input in core and Realtime, re-evaluate current policies on durable approval resumes, reject uncopyable normalized values before conditional approval, and preserve invalid-input handling (#1914, #1915).
