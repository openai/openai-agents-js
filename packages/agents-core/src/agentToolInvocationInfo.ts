export type AgentToolInvocationInfo = Readonly<{
  toolName: string;
  toolCallId?: string;
  toolArguments?: string;
}>;
