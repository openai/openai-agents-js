---
'@openai/agents-extensions': patch
---

fix: the aisdk extension should grab output when toolCalls is a blank array

When the output of a provider includes an empty tool calls array, we'd mistakenly skip over the text result. This patch checks for that condition.
