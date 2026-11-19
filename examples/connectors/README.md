# Calendar connector example

Ask for today's schedule through the Responses API's hosted Calendar connector, or connect the SDK to [Google's Calendar MCP server](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server). The SDK-managed connection works with either the default OpenAI provider or stock Codex. It does not resolve a hosted connector ID or reuse a ChatGPT calendar connection.

## Setup

Set `GOOGLE_CALENDAR_AUTHORIZATION` to a Google OAuth access token. The hosted connector example uses the `https://www.googleapis.com/auth/calendar.events` scope.

For SDK-managed MCP, Google's setup requires Workspace Developer Preview access, a Google Cloud project with the Calendar and Calendar MCP APIs enabled, and an OAuth client with **Use this client for an AI-powered agent** selected. The token must allow event reads. Follow Google's guide for its OAuth consent-screen requirements.

The example exposes only `calendar.list_events`, checks that it exists before asking the model, and hides write tools. A successful first model turn must request an SDK tool. The SDK sends the token as an authorization header to `https://calendarmcp.googleapis.com/mcp/v1`; the model receives the filtered tool definitions and results.

Configure [Codex authentication](../tools/codex-provider.md) for Codex mode. From the repository root:

```sh
# Responses hosted connector
pnpm -F connectors start

# Calendar MCP with the default provider
pnpm -F connectors start --sdk-managed

# Calendar MCP with Codex
pnpm -F connectors start --sdk-managed --codex

# The same Codex workflow with streaming
pnpm -F connectors start --sdk-managed --codex --stream
```

`OPENAI_MODEL` and `CODEX_MODEL` select models for the respective providers. Both SDK-managed commands still require Google's access and OAuth setup. A local MCP protocol test does not verify access to Google's service or to your calendar.
