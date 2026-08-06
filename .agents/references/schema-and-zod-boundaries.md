# Schema and Zod Boundaries

Use this reference for function-tool parameters, structured agent output, strict JSON Schema conversion, Zod v3/v4 compatibility, or provider schema conversion.

## Schema Ownership

- Keep the runtime validator, model-visible JSON Schema, strictness flag, and invocation arguments aligned. A schema that a model can satisfy but the local validator rejects is not compatible.
- `tool()` accepts Zod schemas and plain JSON Schema. Preserve explicit names, descriptions, aliases, required properties, defaults, and refinements where the supported conversion can represent them.
- Structured agent output belongs to the effective agent/model call. Pass it through Responses and Chat Completions using each API's expected request shape without changing the local final-output validation contract.
- Reject unsupported or ambiguous schema shapes at the earliest boundary with enough information to identify the tool or output type.

## Zod v3/v4 Compatibility

- Do not depend on one Zod version's private layout without a guarded compatibility helper. Use `zodCompat.ts` and `zodJsonSchemaCompat.ts` for object detection, parsing, descriptions, decorated fields, unions, enums, records, and fallback behavior.
- Preserve descriptions while unwrapping optional, nullable, defaulted, refined, piped, or transformed schemas. Return an explicit unsupported result when introspection cannot be reliable.
- Reject Zod types that cannot be produced by JSON parsing rather than advertising an impossible model schema.

## Strict Conversion

- Strict function schemas close objects and align required fields with provider expectations. Do not silently make an explicitly open schema mean something narrower without a deliberate contract.
- Copy caller-owned plain schemas before normalization when conversion can mutate nested objects. Reusing a shared schema object must not accumulate provider-specific edits across runs.
- Chat Completions and Responses have different structured-output and tool shapes. Test both converters instead of assuming a strict schema accepted by one path is accepted by the other.

## Review Checklist

1. Test Zod v3, Zod v4, and plain JSON Schema where the public API accepts all three.
2. Compare runtime parsing with the exact schema sent to each provider path.
3. Cover nested objects, unions, enums, optional/nullable fields, descriptions, and unsupported types.
4. Verify strict conversion does not mutate caller-owned schemas or drop definitions.
5. Test tool parameters and structured final output separately in streaming and non-streaming paths.

## Sources

- `packages/agents-core/src/tool.ts`
- `packages/agents-core/src/agent.ts`
- `packages/agents-core/src/utils/strictToolSchema.ts`
- `packages/agents-core/src/utils/zodCompat.ts`
- `packages/agents-core/src/utils/zodJsonSchemaCompat.ts`
- `packages/agents-openai/src/openaiResponsesModel.ts`
- `packages/agents-openai/src/openaiChatCompletionsConverter.ts`
- `packages/agents-core/test/tool.test.ts`
- `packages/agents-core/test/agent.test.ts`
- `packages/agents-core/test/utils/zodJsonSchemaCompat.test.ts`
- `packages/agents-openai/test/openaiResponsesModel.test.ts`
- `packages/agents-openai/test/openaiChatCompletionsConverter.test.ts`
- `docs/src/content/docs/guides/tools.mdx`
