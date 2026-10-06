import { computerTool, type Computer, type ComputerTool } from '@openai/agents';

export function computerToolWithSafetyChecks(computer: Computer): ComputerTool {
  return computerTool({
    computer,
    // Reject every flagged call until the application implements a review flow.
    onSafetyCheck: async () => false,
  });
}
