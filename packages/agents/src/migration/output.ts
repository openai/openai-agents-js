import { isDeepStrictEqual } from 'node:util';
import type { ZodType } from 'zod';
import type { Agent, AgentOutputType } from '@openai/agents-core';
import type { ResolvedAgentOutput } from '@openai/agents-core/types';
import { isZodObject } from '@openai/agents-core/utils';
import { convertAgentOutputTypeToSerializable } from '@openai/agents-core/utils/internal';
import {
  OutputValidationError,
  prepareOutput,
  type PreparedOutput,
} from '../runtime/output';

/** Capture one representable generation contract and its sole local validator. */
export function captureOutput<C, O extends AgentOutputType>(
  agent: Agent<C, O>,
): {
  model: ReturnType<typeof convertAgentOutputTypeToSerializable>;
  native: PreparedOutput<ResolvedAgentOutput<O>>;
} {
  const outputType = agent.outputType;
  if (outputType === 'text')
    return {
      model: 'text',
      native: prepareOutput<ResolvedAgentOutput<O>>(undefined),
    };
  if (agent.handoffs.length) assertTextHandoffOutput(outputType);
  if (!isZodObject(outputType))
    throw new TypeError(
      'Migration output requires text or a supported Zod object',
    );

  const model = convertAgentOutputTypeToSerializable(outputType);
  // Core's optional-Zod structural type is broader than native's Zod type.
  // Native preparation still checks representability before any resource work.
  const native = prepareOutput(
    outputType as unknown as ZodType<ResolvedAgentOutput<O>>,
  );
  if (model === 'text' || native.schema?.type !== 'object')
    throw new TypeError(
      'Migration output requires an object generation schema',
    );

  // Keep Core's descriptor unchanged. Refuse any lowering difference beyond
  // the root dialect marker emitted by the independent schema converters.
  const modelSchema: Record<string, unknown> = { ...model.schema };
  const nativeSchema = { ...native.schema };
  delete modelSchema.$schema;
  delete nativeSchema.$schema;
  if (!isDeepStrictEqual(modelSchema, nativeSchema))
    throw new TypeError(
      'Migration requires matching classic and native output schemas',
    );

  const captured = Object.freeze(agent.clone({ outputType }));
  return {
    model,
    native: {
      ...native,
      parse(text) {
        try {
          return captured.processFinalOutput(text);
        } catch {
          // Retain native's redacted message and omit parser issues and causes.
          throw new OutputValidationError(text);
        }
      },
    },
  };
}

export function assertTextHandoffOutput(outputType: AgentOutputType): void {
  if (outputType !== 'text') {
    throw new TypeError(
      'Migration handoffs require text output on Root and Target; structured output is unsupported; use @openai/agents/classic for the full classic runtime',
    );
  }
}
