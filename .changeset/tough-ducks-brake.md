---
'@openai/agents-core': patch
---

fix: fail zodJsonSchemaCompat union/tuple conversion instead of silently dropping unconvertible members

When the fallback zod-to-JSON-schema converter met a union (or tuple) member it could not convert — for example a discriminated-union variant containing `z.preprocess` — it silently filtered the member out and emitted the remaining schema. The result looked valid but forbade outputs the Zod schema accepts: an agent whose `outputType` union lost a variant could never emit that action under structured outputs. Conversion now fails the whole union/tuple so the caller raises the existing descriptive `UserError` instead of degrading the model's output space.
