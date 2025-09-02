# Customer Service Agent

This example demonstrates a multi-agent service that will retrieve `OWASP` (Open Worldwide Application Security Project) application software vunerabilities then apply them to source code. By default source code will be read from the current directory. This source code will be provided to an agent with vunerability descriptions for analysis, Findings will be written to a report file under the `reports` folder.

Run the demo with:

```bash
pnpm examples:appsec-agent
```
