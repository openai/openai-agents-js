---
name: Bug report
about: Report a bug
title: ''
labels: ''
assignees: ''
---

### Please read this first

- **Have you read the docs?** [Agents SDK docs](https://openai.github.io/openai-agents-js/)
- **Have you searched for related issues?** Others may have faced similar issues.

### Describe the bug

<!-- Clearly and concisely describe the bug. -->

### Debug information

- Agents SDK version:
- Related package versions (optional, e.g. `openai`, `zod`, or `@openai/agents-extensions`):
- Runtime and version (e.g. Node.js, Deno, or Bun):
- Operating system:
- Model and model provider:
- Does the issue reproduce with the latest Agents SDK release?
- Does the issue occur consistently or intermittently?

If an error occurred, include the full stack trace and any relevant logs. Remove API keys, tokens, model input or output, and other sensitive information before posting.

<!-- Paste the stack trace or relevant logs below. -->

```text

```

### Repro steps

Ideally provide a minimal, self-contained JavaScript or TypeScript script that can be run to reproduce the bug.

```typescript
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Example agent',
  instructions: '...',
  // Add the model and any other settings needed to reproduce the bug.
});

const result = await run(agent, '...');
console.log(result.finalOutput);
```

### Expected behavior

<!-- Clearly and concisely describe what you expected to happen. -->
