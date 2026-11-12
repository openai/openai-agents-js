---
'@openai/agents-core': patch
---

perf: Modern Node Core imports have been sharing a packed graph while retaining module identity and lazy optional dependencies.
