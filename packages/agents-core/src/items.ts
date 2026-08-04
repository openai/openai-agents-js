import { Agent } from './agent';
import { toSmartString } from './utils/smartString';
import * as protocol from './types/protocol';
import {
  getFunctionToolStateKeyForCall,
  getToolCallQualifiedName,
} from './toolIdentity';
import type { ToolOutputCustomData } from './utils/customData';

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
    if (this.rawItem.type === 'program') {
      return 'programmatic_tool_calling';
    }
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
      | protocol.ApplyPatchCallResultItem
      | protocol.ProgramCallResultItem,
    public agent: Agent<any, any>,
    public output: string | unknown,
    public customData?: ToolOutputCustomData,
  ) {
    super();
  }

  toJSON() {
    return {
      ...super.toJSON(),
      agent: this.agent.toJSON(),
      output: toSmartString(this.output),
      customData: this.customData,
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
    /** @internal Canonical function-tool key used by approval and resume state. */
    public functionToolStateKey?: string,
  ) {
    super();
    this.toolName = toolName ?? getDefaultApprovalToolName(rawItem);
    this.functionToolStateKey =
      functionToolStateKey ?? getDefaultApprovalFunctionToolStateKey(rawItem);
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
      functionToolStateKey: this.functionToolStateKey,
    };
  }
}

function getDefaultApprovalFunctionToolStateKey(
  rawItem: RunToolApprovalItem['rawItem'],
): string | undefined {
  if (rawItem.type !== 'function_call') {
    return undefined;
  }
  return getFunctionToolStateKeyForCall(rawItem);
}

function getDefaultApprovalToolName(
  rawItem: RunToolApprovalItem['rawItem'],
): string | undefined {
  if (rawItem.type !== 'function_call') {
    return (rawItem as any).name;
  }

  if (
    typeof rawItem.name === 'string' &&
    typeof rawItem.namespace === 'string' &&
    rawItem.namespace === rawItem.name
  ) {
    return rawItem.name;
  }

  return getToolCallQualifiedName(rawItem) ?? rawItem.name;
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
