export type AgentToolInvocation = Readonly<{
  toolName: string;
  toolCallId?: string;
  toolArguments?: string;
}>;
