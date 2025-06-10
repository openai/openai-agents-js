import { Agent } from './agent';
import { toSmartString } from './utils/smartString';
import * as protocol from './types/protocol';

export class RunItemBase {
  public readonly type: string = 'base_item' as const;
  public rawItem?: protocol.ModelItem;

  toJSON() {
    return {
      type: this.type,
      rawItem: this.rawItem,
    };
  }
}

export class RunMessageOutputItem extends RunItemBase {
  public readonly type = 'message_output_item' as const;

  constructor(
    public rawItem: protocol.AssistantMessageItem,
    public agent: Agent,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
    };
  }

  get content(): string {
    let content = '';
    for (const part of this.rawItem.content) {
      if (part.type === 'output_text') {
        content += part.text;
      }
    }
    return content;
  }
}

export class RunToolCallItem extends RunItemBase {
  public readonly type = 'tool_call_item' as const;

  constructor(
    public rawItem: protocol.ToolCallItem,
    public agent: Agent,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
    };
  }
}

export class RunToolCallOutputItem extends RunItemBase {
  public readonly type = 'tool_call_output_item' as const;

  constructor(
    public rawItem:
      | protocol.FunctionCallResultItem
      | protocol.ComputerCallResultItem,
    public agent: Agent<any, any>,
    public output: string | unknown,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
      output: toSmartString(this.output),
    };
  }
}

export class RunReasoningItem extends RunItemBase {
  public readonly type = 'reasoning_item' as const;

  constructor(
    public rawItem: protocol.ReasoningItem,
    public agent: Agent,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
    };
  }
}

export class RunHandoffCallItem extends RunItemBase {
  public readonly type = 'handoff_call_item' as const;

  constructor(
    public rawItem: protocol.FunctionCallItem,
    public agent: Agent,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
    };
  }
}

export class RunHandoffOutputItem extends RunItemBase {
  public readonly type = 'handoff_output_item' as const;

  constructor(
    public rawItem: protocol.FunctionCallResultItem,
    public sourceAgent: Agent<any, any>,
    public targetAgent: Agent<any, any>,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      sourceAgent: this.sourceAgent.toJSON(),
      targetAgent: this.targetAgent.toJSON(),
    };
  }
}

export class RunToolApprovalItem extends RunItemBase {
  public readonly type = 'tool_approval_item' as const;

  constructor(
    public rawItem: protocol.FunctionCallItem | protocol.HostedToolCallItem,
    public agent: Agent<any, any>,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
    };
  }
}

export type RunItem =
  | RunMessageOutputItem
  | RunToolCallItem
  | RunReasoningItem
  | RunHandoffCallItem
  | RunToolCallOutputItem
  | RunHandoffOutputItem
  | RunToolApprovalItem;

/**
 * Extract all text output from a list of run items by concatenating the content of all
 * message output items.
 *
 * @param items - The list of run items to extract text from.
 * @returns A string of all the text output from the run items.
 */
export function extractAllTextOutput(items: RunItem[]) {
  return items
    .filter((item) => item.type === 'message_output_item')
    .map((item) => item.content)
    .join('');
}
