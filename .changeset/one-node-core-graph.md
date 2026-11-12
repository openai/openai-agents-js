---
'@openai/agents-core': patch
---

Share the same Core implementation across CommonJS and ESM on Node.js when Node supports the module-sync condition. This reduces startup memory for applications that use the native SDK and its ESM facade.
