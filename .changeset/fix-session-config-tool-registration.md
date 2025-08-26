---
'@openai/agents-realtime': patch
---

Fix session config breaking tool registration

When initializing a RealtimeSession with any config object, tool registration was being broken because empty or undefined tools arrays were being sent to the OpenAI API, which disabled tool calls. This fix ensures that the tools field is only included in session updates when tools are actually present, preventing the API from disabling tool functionality when session configuration is provided.

The issue occurred because the `_getMergedSessionConfig` method would include `tools: undefined` in the session data when no tools were explicitly provided in the config, which the OpenAI API interpreted as a request to disable all tools. Now, the tools field is only included when tools are actually available and non-empty.

This allows users to customize audio settings (voice, turn detection, noise reduction, etc.) while maintaining tool functionality, resolving the mutual exclusivity between session configuration and tool registration.