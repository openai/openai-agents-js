---
name: ai-sdk-knowledge
description: Use when working with the Vercel AI SDK (`@ai-sdk/*`) and you need authoritative documentation or repository references. Prefer the DeepWiki MCP server to retrieve repo docs and answer questions; if it is not configured, guide the user to enable `deepwiki`.
---

# AI SDK Knowledge

## Overview

Use the DeepWiki MCP server to read documentation for public repositories (including `vercel/ai`) or to ask questions about them. Base your answers on the returned content instead of guessing.

## Workflow

### 1) Check whether the DeepWiki MCP server is available

If the DeepWiki MCP tools are available (for example, tool names like `read_wiki_structure`, `read_wiki_contents`, `ask_question`), use them.

If you are unsure, run `codex mcp list` and check for a server named `deepwiki`.

### 2) Use MCP tools to pull exact docs

- For structure: call `read_wiki_structure` with the repository (e.g., `vercel/ai`).
- For content: call `read_wiki_contents` to fetch specific sections.
- For Q&A: call `ask_question` with the repository name and your question.

Use the returned content directly—do not invent APIs or behaviors.

### 3) If MCP is not configured, guide setup (do not change config unless asked)

For Codex, use the streamable HTTP endpoint:

- CLI: `codex mcp add deepwiki --url https://mcp.deepwiki.com/mcp`
- Config (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.deepwiki]
  url = "https://mcp.deepwiki.com/mcp"
  ```

(Other clients may support SSE at `https://mcp.deepwiki.com/sse`, but Codex uses the HTTP stream.)

After adding, ask the user to restart the Codex session so the tools load.

Reference: https://docs.devin.ai/work-with-devin/deepwiki-mcp
