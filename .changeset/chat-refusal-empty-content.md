---
'@openai/agents-openai': patch
---

fix: preserve chat completion refusal when content is an empty string

Some providers (e.g. Azure OpenAI) return an empty-string `content` alongside a
refusal instead of `null`. The non-streaming Chat Completions converter treated
that empty string as real content and emitted a blank assistant `output_text`
message, silently dropping the refusal. It now falls through to the refusal
branch, matching the streaming converter which already surfaces the refusal.
