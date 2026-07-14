---
'@openai/agents-openai': patch
---

fix: preserve token usage reported on earlier Chat Completions stream chunks

When streaming Chat Completions, usage was overwritten on every chunk, so a trailing chunk without usage reset the previously reported totals to zero. Some providers (e.g. xAI/Grok via LiteLLM) attach usage to an earlier chunk rather than the final one, which caused `response_done` to report `inputTokens`/`outputTokens`/`totalTokens` as 0. Usage is now retained when a later chunk omits it, while the normal OpenAI path (usage on the final chunk) is unchanged.
