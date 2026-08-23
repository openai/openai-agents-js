import type { Agent } from '../agent';
import type { RunContext } from '../runContext';

export const OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT =
  'Output withheld by an output guardrail.';

export type OutputGuardrailBlockedMessageArgs<TContext = unknown> = {
  /**
   * The SDK's default data-free placeholder.
   */
  defaultMessage: string;
  /**
   * The name of the output guardrail observed rejecting terminal tool output in the current run.
   */
  guardrailName: string;
  /**
   * The agent whose terminal tool output was rejected.
   */
  agent: Agent<TContext, any>;
  /**
   * The active run context for the current execution.
   */
  runContext: RunContext<TContext>;
};

export type OutputGuardrailBlockedMessageFormatter<TContext = unknown> = (
  args: OutputGuardrailBlockedMessageArgs<TContext>,
) => Promise<string | undefined> | string | undefined;

export type OutputGuardrailBlockedMessage<TContext = unknown> =
  string | OutputGuardrailBlockedMessageFormatter<TContext>;

type OutputGuardrailBlockedMessageState<TContext> = {
  _currentAgent: Agent<TContext, any>;
  _context: RunContext<TContext>;
};

async function resolveOutputGuardrailBlockedMessage<TContext>(
  configured: OutputGuardrailBlockedMessage<TContext>,
  args: OutputGuardrailBlockedMessageArgs<TContext>,
): Promise<string> {
  if (typeof configured === 'string') {
    return configured.length > 0 ? configured : args.defaultMessage;
  }

  try {
    const resolved = await configured(args);
    if (typeof resolved === 'string' && resolved.length > 0) {
      return resolved;
    }
  } catch {
    // Formatter failures fail closed without exposing error details.
  }
  return args.defaultMessage;
}

export function createOutputGuardrailBlockedMessageResolver<TContext>(
  configured: OutputGuardrailBlockedMessage<TContext> | undefined,
  state: OutputGuardrailBlockedMessageState<TContext>,
): ((guardrailName: string) => Promise<string>) | undefined {
  if (configured === undefined) {
    return undefined;
  }
  return (guardrailName) =>
    resolveOutputGuardrailBlockedMessage(configured, {
      defaultMessage: OUTPUT_GUARDRAIL_BLOCKED_TOOL_OUTPUT,
      guardrailName,
      agent: state._currentAgent,
      runContext: state._context,
    });
}
