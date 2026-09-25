# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through the reporting channels in OpenAI's [Coordinated Vulnerability Disclosure Policy](https://openai.com/policies/coordinated-vulnerability-disclosure-policy/). Follow that policy for coordinated disclosure and program eligibility. OpenAI's [security contact and PGP key information](https://cdn.openai.com/security.txt) are also available.

Do not open a public GitHub issue or pull request for an undisclosed vulnerability, or post vulnerability details in public discussions, logs, or artifacts. Use the private reporting route even if you are unsure whether the issue is a vulnerability. Ordinary bugs and feature requests can follow [CONTRIBUTING.md](CONTRIBUTING.md#reporting-issues).

Include the following in a private report when available:

- The affected package names and versions, repository revision, runtime, and operating system.
- A description of the behavior, the expected security property, and the potential impact.
- Minimal reproduction steps using synthetic data, including relevant configuration and prerequisites.
- Sanitized logs or other evidence that help identify the affected code path.

Remove API keys, authorization headers, cookies, access tokens, webhook secrets, signed URLs, customer data, and personal information from reports and attachments. Agent prompts, tool arguments and results, audio, traces, and serialized session or run state can contain sensitive data; replace that data with synthetic values. Never include a working credential to demonstrate an issue. If a credential is exposed, revoke or rotate it promptly and report the exposure privately; deleting the visible copy alone does not invalidate it.

## Repository scope

This policy covers the source and published packages maintained in this repository:

- `@openai/agents`: the convenience package.
- `@openai/agents-core`: agent execution, tools, sessions, run state, tracing, MCP integration, and sandbox abstractions.
- `@openai/agents-openai`: OpenAI model and tracing integrations.
- `@openai/agents-realtime`: Realtime sessions and transports.
- `@openai/agents-extensions`: adapters and integrations, including sandbox providers.

Repository-owned examples, dependencies, build scripts, GitHub Actions workflows, and package publication are also relevant security surfaces. Dependency reports should distinguish published runtime exposure from development, test, or example exposure and describe the reachable impact; development dependencies are not automatically out of scope. This scope does not establish bounty eligibility or a supported-version or remediation-time guarantee.

## Security boundaries

Applications configure the SDK's tools, endpoints, credentials, storage, and execution environments. Model output, tool and MCP responses, remote content, and persisted state can cross trust boundaries. Review suspected issues against the permissions and security properties the affected SDK feature is intended to enforce, including tool approvals, credential handling, data disclosure, and sandbox path or execution restrictions.

Report concrete failures of SDK-owned controls through the private route above. Application configuration and third-party services can affect impact, but do not dismiss a report solely because an integration is involved. The SDK does not make arbitrary application tools or model-generated actions safe by itself; applications must select appropriate authorization and isolation for the capabilities they expose.

Contributor and automated-agent practices for protecting these boundaries are documented in [CONTRIBUTING.md](CONTRIBUTING.md#security) and [AGENTS.md](AGENTS.md#security-requirements).
