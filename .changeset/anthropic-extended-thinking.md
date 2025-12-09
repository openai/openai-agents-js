---
'@openai/agents-extensions': minor
---

Add support for Anthropic extended thinking (reasoning) in the AI SDK adapter.

This feature enables capturing and preserving Claude's extended thinking blocks when using the AI SDK adapter with Anthropic models. Key changes:

- Non-streaming: Extract reasoning parts from AI SDK responses and output them as `ReasoningItem` objects before tool calls (required by Anthropic API)
- Streaming: Handle `reasoning-start`, `reasoning-delta`, and `reasoning-end` events to accumulate thinking content
- Signature preservation: Store Anthropic's thinking signature in `providerData` for multi-turn conversation support
- Round-trip support: Existing `itemsToLanguageV2Messages` already passes `providerData` to `providerOptions`, enabling signatures to be sent back to the API

Fixes #628
