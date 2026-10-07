---
'@openai/agents-core': patch
---

fix: redact unchecked terminal tool output in cancelled session checkpoints while preserving completion history; defer validation for caller-owned RunState resumes
