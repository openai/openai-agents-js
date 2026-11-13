import type { Agent } from './public-agent';
import {
  captureTools,
  tool,
  ToolOutput,
  type FunctionTool,
  type SessionTool,
} from './tools';
import { z } from 'zod';
import { withHandoffResultTarget } from './handoff-result';

/** Callback-backed native transfer to a captured Agent.
 * The callback has been supplying the name, description, schema and acknowledgement.
 * The existing tool owner has been validating arguments and awaiting callback cleanup
 * before publishing an accepted target. Failed or cancelled callbacks have not been
 * activating the target.
 */
export class Handoff<Context = undefined, Output = string> {
  readonly callback: FunctionTool<Context>;

  constructor(
    readonly target: Agent<Context, Output>,
    callback: FunctionTool<Context>,
  ) {
    const declarations: readonly SessionTool[] = [callback];
    const catalog = captureTools(declarations);
    const captured = catalog.tools[0];
    if (captured.kind === 'manual')
      throw new TypeError(
        'A handoff callback must run without a managed approval',
      );
    if (captured.allowedCallers?.includes('direct') === false)
      throw new TypeError('A handoff callback must allow direct model calls');
    if (captured.finishTurn)
      throw new TypeError('A handoff callback cannot finish the turn');
    if (captured.namespace != null && captured.namespace !== 'functions')
      throw new TypeError(
        'A handoff callback must use the default function namespace',
      );
    if (JSON.parse(catalog.specsJson)[0].type === 'computer')
      throw new TypeError('A handoff requires an ordinary function callback');
    this.callback = captured;
    Object.freeze(this);
  }
}

/** A captured roster selected by Decisions only when the main model invokes it. */
export class DecisionHandoff<Context = undefined, Output = string> {
  readonly name: string;
  readonly description: string;
  readonly question: string;
  readonly targets: Readonly<Record<string, Agent<Context, Output>>>;

  constructor(options: {
    name: string;
    description: string;
    question: string;
    targets: Readonly<Record<string, Agent<Context, Output>>>;
  }) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.name))
      throw new TypeError('DecisionHandoff requires a valid function name');
    if (!options.description?.trim() || !options.question?.trim())
      throw new TypeError('DecisionHandoff requires description and question');
    const entries = Object.entries(options.targets);
    if (
      entries.length === 0 ||
      entries.length > 64 ||
      entries.some(([name]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    )
      throw new TypeError('DecisionHandoff requires 1 to 64 named targets');
    this.name = options.name;
    this.description = options.description;
    this.question = options.question;
    this.targets = Object.freeze(Object.fromEntries(entries));
    Object.freeze(this);
  }
}

/** Bind immutable captured profile IDs before callback admission. */
export function decisionHandoffTool<Context>(
  declaration: DecisionHandoff<Context, any>,
  profiles: Readonly<Record<string, string>>,
): FunctionTool<Context> {
  const choices = Object.keys(profiles);
  return tool({
    name: declaration.name,
    description: declaration.description,
    parameters: z.strictObject({ input: z.string().max(8192) }),
    execute: async ({ input }, context) => {
      if (new TextEncoder().encode(input).byteLength > 8192)
        throw new TypeError(
          'DecisionHandoff routing input exceeds 8192 UTF-8 bytes',
        );
      const selected = await context.decide(declaration.question, {
        input,
        choices,
        signal: context.signal,
      });
      context.signal.throwIfAborted();
      if (!Object.hasOwn(profiles, selected))
        throw new TypeError(
          'DecisionHandoff selection is outside its captured targets',
        );
      return withHandoffResultTarget(
        new ToolOutput(
          [{ type: 'inputText', text: 'Handoff reserved.' }],
          true,
        ),
        profiles[selected],
      );
    },
  });
}
