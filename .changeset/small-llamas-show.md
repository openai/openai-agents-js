---
'@openai/agents-core': patch
---

fix: include `type` in `buildEnum` fallback schema for enum definitions

The fallback JSON Schema converter omitted the `type` field from enum schemas,
producing `{ enum: [...] }` instead of `{ type: "string", enum: [...] }`.
Providers following OpenAPI 3.0 conventions (e.g. Google Gemini) rejected these
schemas. The fix infers the type from enum values, matching the behavior of the
primary path's vendored zod-to-json-schema parsers.
