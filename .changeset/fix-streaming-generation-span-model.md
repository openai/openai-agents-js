---
'@openai/agents-openai': patch
---

fix: populate model and model_config on generation span in streaming mode

`getStreamedResponse()` in `OpenAIChatCompletionsModel` was not setting `span.spanData.model` or `span.spanData.model_config` on the generation span, causing downstream tracing exporters to report the model as "unknown". The non-streaming `getResponse()` path already set these fields correctly.
