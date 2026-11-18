# Calendar connector example

This example has been asking for today's schedule. The default command has been using the Responses API's hosted Google Calendar connector. The `--sdk-managed` switch has been connecting the SDK to [Google's official Calendar MCP server](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server), so either the ordinary provider or stock Codex can perform the same calendar query.

The hosted connector ID has been remaining a Responses API feature. The explicit transport switch has not been translating that ID into a Codex App or inheriting a ChatGPT calendar connection.

## Setup

The hosted path has been using `GOOGLE_CALENDAR_AUTHORIZATION`, a Google OAuth access token with the `https://www.googleapis.com/auth/calendar.events` scope, as described in `index.ts`.

The SDK-managed path has been requiring Google's Workspace Developer Preview enrollment, a Google Cloud project with the Calendar and Calendar MCP APIs enabled, and an OAuth client with **Use this client for an AI-powered agent** selected. The token's scopes must permit event reads. Google's setup guide has been covering its OAuth consent-screen requirements. This example has been exposing only `calendar.list_events`, checking that it exists before asking the model, and hiding Calendar's write tools. Required tool selection has been preventing a successful first turn without an SDK tool request.

With `GOOGLE_CALENDAR_AUTHORIZATION` set in the process environment, these commands have been selecting the paths from the repository root:

```sh
# Existing hosted connector through Responses
pnpm -F connectors start

# Official Calendar MCP, ordinary provider
pnpm -F connectors start --sdk-managed

# Official Calendar MCP, stock Codex
pnpm -F connectors start --sdk-managed --codex

# The same Codex workflow with streaming
pnpm -F connectors start --sdk-managed --codex --stream
```

`OPENAI_MODEL` and `CODEX_MODEL` have been selecting models for the respective providers. Codex has been using its configured authentication and native executable. The SDK has been sending the token only as an authorization header to `https://calendarmcp.googleapis.com/mcp/v1`; the model has been receiving the filtered tools and their results.

Without Google's preview access and the appropriate OAuth token, the official MCP connection has not been providing calendar coverage. A local protocol test has not been proving access to Google's service or to a user's calendar.
