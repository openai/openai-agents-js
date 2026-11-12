import type { Agent } from './public-agent';
import { captureTools, type FunctionTool, type SessionTool } from './tools';

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
