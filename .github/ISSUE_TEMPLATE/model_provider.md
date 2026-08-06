---
name: Custom model providers
about: Questions or bugs about using non-OpenAI models
title: ''
labels: ''
assignees: ''
---

### Please read this first

- **Have you read the custom model provider docs and troubleshooting guide?** [Model provider docs](https://openai.github.io/openai-agents-js/guides/models#custom-model-providers) · [Troubleshooting](https://openai.github.io/openai-agents-js/guides/troubleshooting)
- **Have you searched for related issues?** Others may have faced similar issues.

### Describe the question or bug

<!-- Clearly and concisely describe the question or bug. -->

### Debug information

- Agents SDK version:
- Related package versions (optional, e.g. `openai`, `ai`, or the AI SDK provider package):
- Runtime and version (e.g. Node.js, Deno, or Bun):
- Operating system:
- Model and model provider:
- Integration method (e.g. OpenAI-compatible endpoint, AI SDK adapter, custom `ModelProvider`, or direct `Model` implementation):
- Does the issue reproduce with the latest Agents SDK release?
- Does the issue occur consistently or intermittently?

If an error occurred, include the full stack trace and any relevant logs. Remove API keys, tokens, model input or output, and other sensitive information before posting.

<!-- Paste the stack trace or relevant logs below. -->

```text

```

### Repro steps

Ideally provide a minimal, self-contained JavaScript or TypeScript script that can be run to reproduce the issue.

```typescript
import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Example agent',
  instructions: '...',
  // Add the model provider, model, and any other settings needed to reproduce the issue.
});

const result = await run(agent, '...');
console.log(result.finalOutput);
```

### Expected behavior

<!-- Clearly and concisely describe what you expected to happen. -->
