---
'@openai/agents-core': patch
---

On supported Linux x64 builds of Node.js 22 and 24, the runner has been deferring independent copies of plain text history until use. Other runtimes and unsupported input shapes have been using the existing copy path.
