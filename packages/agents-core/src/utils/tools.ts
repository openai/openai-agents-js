import type { ZodObject } from 'zod';
import { zodResponsesFunction, zodTextFormat } from 'openai/helpers/zod';
import { UserError } from '../errors';
import { ToolInputParameters } from '../tool';
import { JsonObjectSchema, JsonSchemaDefinition, TextOutput } from '../types';
import { isZodObject } from './typeGuards';
import { AgentOutputType } from '../agent';
import {
  fallbackJsonSchemaFromZodObject,
  hasJsonSchemaObjectShape,
} from './zodFallback';

export type FunctionToolName = string & { __brand?: 'ToolName' } & {
  readonly __pattern?: '^[a-zA-Z0-9_]+$';
};

// openai/helpers/zod cannot emit strict schemas for every Zod runtime
// (notably Zod v4), so we delegate to a small local converter living in
// zodFallback.ts whenever its output is missing the required JSON Schema bits.
function buildJsonSchemaFromZod(
  inputType: ZodObject<any>,
): JsonObjectSchema<any> | undefined {
  return fallbackJsonSchemaFromZodObject(inputType);
}

/**
 * Convert a string to a function tool name by replacing spaces with underscores and
 * non-alphanumeric characters with underscores.
 * @param name - The name of the tool.
 * @returns The function tool name.
 */
export function toFunctionToolName(name: string): FunctionToolName {
  // Replace spaces with underscores
  name = name.replace(/\s/g, '_');

  // Replace non-alphanumeric characters with underscores
  name = name.replace(/[^a-zA-Z0-9]/g, '_');

  // Ensure the name is not empty
  if (name.length === 0) {
    throw new Error('Tool name cannot be empty');
  }

  return name as FunctionToolName;
}

/**
 * Get the schema and parser from an input type. If the input type is a ZodObject, we will convert
 * it into a JSON Schema and use Zod as parser. If the input type is a JSON schema, we use the
 * JSON.parse function to get the parser.
 * @param inputType - The input type to get the schema and parser from.
 * @param name - The name of the tool.
 * @returns The schema and parser.
 */
export function getSchemaAndParserFromInputType<T extends ToolInputParameters>(
  inputType: T,
  name: string,
): {
  schema: JsonObjectSchema<any>;
  parser: (input: string) => any;
} {
  const parser = (input: string) => JSON.parse(input);

  if (isZodObject(inputType)) {
    const formattedFunction = zodResponsesFunction({
      name,
      parameters: inputType,
      function: () => {}, // empty function here to satisfy the OpenAI helper
      description: '',
    });
    if (hasJsonSchemaObjectShape(formattedFunction.parameters)) {
      return {
        schema: formattedFunction.parameters as JsonObjectSchema<any>,
        parser: formattedFunction.$parseRaw,
      };
    }

    const fallbackSchema = buildJsonSchemaFromZod(inputType);

    if (fallbackSchema) {
      return {
        schema: fallbackSchema,
        parser: (rawInput: string) => inputType.parse(JSON.parse(rawInput)),
      };
    }

    throw new UserError(
      'Unable to convert the provided Zod schema to JSON Schema. Ensure that the `zod` package is available at runtime or provide a JSON schema object instead.',
    );
  } else if (typeof inputType === 'object' && inputType !== null) {
    return {
      schema: inputType,
      parser,
    };
  }

  throw new UserError('Input type is not a ZodObject or a valid JSON schema');
}

/**
 * Converts the agent output type provided to a serializable version
 */
export function convertAgentOutputTypeToSerializable(
  outputType: AgentOutputType,
): JsonSchemaDefinition | TextOutput {
  if (outputType === 'text') {
    return 'text';
  }

  if (isZodObject(outputType)) {
    const output = zodTextFormat(outputType, 'output');
    return {
      type: output.type,
      name: output.name,
      strict: output.strict || false,
      schema: output.schema as JsonObjectSchema<any>,
    };
  }

  return outputType;
}
