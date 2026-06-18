---
'@openai/agents-openai': patch
---

fix(openai): honor top-level `input_image.detail` in the Chat Completions converter

The Chat Completions converter only read `detail` from `providerData.image_url.detail` and silently dropped the top-level `detail` field, even though the protocol defines it as a top-level field and both the Responses path and the Python SDK honor it. Top-level `detail` is now forwarded (with `providerData.image_url.detail` still taking precedence).
