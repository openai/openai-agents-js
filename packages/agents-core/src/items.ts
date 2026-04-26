import { Agent } from './agent';
import { toSmartString } from './utils/smartString';
import * as protocol from './types/protocol';
import {
  getFunctionToolQualifiedName,
  resolveFunctionToolCallName,
} from './toolIdentity';

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

  get toolName(): string | undefined {
    return getStringProperty(this.rawItem, 'name');
  }

  get callId(): string | undefined {
    return (
      getStringProperty(this.rawItem, 'callId') ??
      getStringProperty(this.rawItem, 'id')
    );
  }
}

export class RunToolSearchCallItem extends RunItemBase {
  public readonly type = 'tool_search_call_item' as const;

  constructor(
    public rawItem: protocol.ToolSearchCallItem,
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

export class RunToolSearchOutputItem extends RunItemBase {
  public readonly type = 'tool_search_output_item' as const;

  constructor(
    public rawItem: protocol.ToolSearchOutputItem,
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
      | protocol.ComputerCallResultItem
      | protocol.ShellCallResultItem
      | protocol.ApplyPatchCallResultItem,
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

  get callId(): string | undefined {
    return (
      getStringProperty(this.rawItem, 'callId') ??
      getStringProperty(this.rawItem, 'id')
    );
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
    public rawItem:
      | protocol.FunctionCallItem
      | protocol.HostedToolCallItem
      | protocol.ComputerUseCallItem
      | protocol.ShellCallItem
      | protocol.ApplyPatchCallItem,
    public agent: Agent<any, any>,
    /**
     * Explicit tool name to use for approval tracking when not present on the raw item.
     */
    public toolName?: string,
  ) {
    super();
    this.toolName = toolName ?? getDefaultApprovalToolName(rawItem, agent);
  }

  /**
   * Returns the tool name if available on the raw item or provided explicitly.
   * Kept for backwards compatibility with code that previously relied on `rawItem.name`.
   */
  get name(): string | undefined {
    return this.toolName ?? (this.rawItem as any).name;
  }

  /**
   * Returns the arguments if the raw item has an arguments property otherwise this will be undefined.
   */
  get arguments(): string | undefined {
    return 'arguments' in this.rawItem ? this.rawItem.arguments : undefined;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
      toolName: this.toolName,
    };
  }
}

function getDefaultApprovalToolName(
  rawItem: RunToolApprovalItem['rawItem'],
  agent: Agent<any, any>,
): string | undefined {
  if (rawItem.type !== 'function_call') {
    return (rawItem as any).name;
  }

  const availableFunctionTools = new Map(
    agent.tools.flatMap((tool) => {
      if (tool.type !== 'function' || typeof tool.name !== 'string') {
        return [];
      }
      return [[getFunctionToolQualifiedName(tool) ?? tool.name, tool] as const];
    }),
  );

  const resolvedToolName = resolveFunctionToolCallName(
    rawItem,
    availableFunctionTools,
  );

  if (
    typeof rawItem.name === 'string' &&
    typeof rawItem.namespace === 'string' &&
    rawItem.namespace === rawItem.name &&
    !availableFunctionTools.has(`${rawItem.namespace}.${rawItem.name}`)
  ) {
    return rawItem.name;
  }

  return resolvedToolName ?? rawItem.name;
}

function getStringProperty(item: object, key: string): string | undefined {
  const value = (item as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export type RunItem =
  | RunMessageOutputItem
  | RunToolCallItem
  | RunToolSearchCallItem
  | RunToolSearchOutputItem
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
