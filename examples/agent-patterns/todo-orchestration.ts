import {
  Agent,
  run,
  tool,
  withTrace,
  AgentInputItem,
  RunResult,
  RunState,
} from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';

// Configuration
const APPROVAL_ENABLED = process.env.APPROVAL_ENABLED === 'true' || false;
const MAX_ITERATIONS = 10;

// Sample Tools - Four trivial tools for demonstration
const calculatorTool = tool({
  name: 'calculator',
  description: 'Perform basic arithmetic operations',
  parameters: z.object({
    operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
    a: z.number(),
    b: z.number(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ operation, a, b }: { operation: 'add' | 'subtract' | 'multiply' | 'divide', a: number, b: number }) => {
    let result: number = 0;
    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        result = b !== 0 ? a / b : NaN;
        break;
    }
    return `Calculation: ${a} ${operation} ${b} = ${result}`;
  },
});

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get weather information for a city',
  parameters: z.object({
    city: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ city }: { city: string }) => {
    // Simulated weather data
    const conditions = ['sunny', 'cloudy', 'rainy', 'snowy'];
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    const temp = Math.floor(Math.random() * 30) + 10;
    return `Weather in ${city}: ${condition}, ${temp}°C`;
  },
});

const fileWriterTool = tool({
  name: 'write_file',
  description: 'Write content to a file',
  parameters: z.object({
    filename: z.string(),
    content: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ filename, content }: { filename: string, content: string }) => {
    try {
      await fs.writeFile(filename, content, 'utf-8');
      return `Successfully wrote content to ${filename}`;
    } catch (error) {
      return `Error writing to ${filename}: ${error}`;
    }
  },
});

const timerTool = tool({
  name: 'timer',
  description: 'Set a timer for specified seconds',
  parameters: z.object({
    seconds: z.number(),
    message: z.string().nullable().optional(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ seconds, message }: { seconds: number, message?: string | null }) => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const elapsed = (Date.now() - start) / 1000;
    return `Timer completed after ${elapsed}s${message ? `: ${message}` : ''}`;
  },
});

// Available tool descriptions for LLM analysis
const TOOL_DESCRIPTIONS = {
  calculator: 'Perform basic arithmetic operations (add, subtract, multiply, divide)',
  get_weather: 'Get weather information for any city worldwide',
  write_file: 'Write content to files on the filesystem',
  timer: 'Set timers for specified durations with optional messages'
};

// All available tools
const ALL_TOOLS = [calculatorTool, weatherTool, fileWriterTool, timerTool];

// Action Agent - Executes single tools with optional approval
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: [
    'You are an action agent that executes exactly one tool at a time.',
    'Use the provided tools to complete the specific task given to you.',
    'Be precise and focused in your tool usage.',
    'Return immediately after using one tool.'
  ].join(' '),
  tools: [], // Tools will be set dynamically
  toolUseBehavior: 'stop_on_first_tool',
  modelSettings: { toolChoice: 'required' },
});

// Task Status Schema
const TaskStatus = z.object({
  completed_tasks: z.array(z.string()),
  pending_tasks: z.array(z.string()),
  current_task: z.string().nullable().optional(),
  is_complete: z.boolean(),
  next_action: z.string().nullable().optional(),
});

// Orchestration Agent - Manages todo list and coordinates execution
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: [
    'You are an orchestration agent that manages task execution and maintains a to-do list.',
    'Break down user requests into specific, actionable tasks.',
    'Available tools: calculator (math operations), get_weather (weather info), write_file (file operations), timer (set timers).',
    'For each current_task, intelligently select which tools the action agent should use.',
    'Track progress and determine when all tasks are complete.',
    'Respond with JSON: {"completed_tasks": [], "pending_tasks": [], "current_task": "...", "selected_tools": ["tool1", "tool2"], "tool_reasoning": "why these tools", "is_complete": false}'
  ].join(' '),
  // No tools needed - this agent just plans and selects
});

// Human approval functions
async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await rl.question(`${question} (y/n): `);
  const normalizedAnswer = answer.toLowerCase();
  rl.close();
  return normalizedAnswer === 'y' || normalizedAnswer === 'yes';
}

async function handleApprovals(
  result: any
): Promise<any> {
  let currentResult = result;
  
  while (currentResult.interruptions?.length > 0) {
    // Store state for resumption
    await fs.writeFile(
      'orchestration-state.json',
      JSON.stringify(currentResult.state, null, 2),
      'utf-8'
    );

    // Read state back
    const storedState = await fs.readFile('orchestration-state.json', 'utf-8');
    const state = await RunState.fromString(actionAgent, storedState);

    // Handle each interruption
    for (const interruption of currentResult.interruptions) {
      console.log(`
>> 🤝 HUMAN APPROVAL REQUIRED
   Agent: Action Agent
   Tool: ${interruption.rawItem.name}
   Args: ${interruption.rawItem.arguments}
-------------------------------------------------------------------`);
      
      console.log(`
⏳ WAITING FOR USER INPUT =========================================
   System paused - no LLM calls active
   Waiting for approval decision...
===================================================================`);
      
      const confirmed = await confirm(`Approve this tool execution?`);
      
      console.log(`
📝 USER DECISION RECEIVED =========================================
   Decision: ${confirmed ? 'APPROVED' : 'REJECTED'}
   Resuming agent execution...
===================================================================`);

      if (confirmed) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }

    // Resume execution
    console.log(`
🤖 LLM CALL STARTING ===================================================
   Agent: Action Agent (Resume after approval)
   Purpose: Continue execution with approved/rejected tools
   State: Restored from interruption
===================================================================`);
    
    const resumeStartTime = Date.now();
    currentResult = await run(actionAgent, state);
    const resumeDuration = Date.now() - resumeStartTime;
    
    console.log(`
✅ LLM CALL COMPLETED =================================================
   Duration: ${resumeDuration}ms
   Status: ${currentResult.interruptions?.length > 0 ? 'More approvals needed' : 'Execution complete'}
===================================================================`);
  }

  return currentResult;
}

// Main orchestration function
async function executeTask(userRequest: string): Promise<string> {
  let inputItems: AgentInputItem[] = [{ role: 'user', content: userRequest }];
  let iterations = 0;
  let finalAnswer = '';

  console.log(`
===============================================================================
                       🎯 TODO ORCHESTRATION SYSTEM                        
===============================================================================
Task: ${userRequest}
Mode: ${APPROVAL_ENABLED ? 'APPROVAL ENABLED' : 'AUTO EXECUTION'}
===============================================================================`);

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`
-------------------------------------------------------------------------------
                             ITERATION ${iterations}                              
-------------------------------------------------------------------------------`);

    // Orchestration phase: Plan and select tools
    console.log(`
>> 🧠 ORCHESTRATION AGENT
   Planning and managing task coordination...`);

    console.log(`
🤖 LLM CALL STARTING ===================================================
   Agent: Orchestration Agent
   Purpose: Task planning and todo list management
   Input Items: ${inputItems.length} message(s)
===================================================================`);
    
    const startTime = Date.now();
    const orchestrationResult = await run(orchestrationAgent, inputItems);
    const duration = Date.now() - startTime;
    
    console.log(`
✅ LLM CALL COMPLETED =================================================
   Duration: ${duration}ms
   Response: Structured task status received
===================================================================`);
    
    if (!orchestrationResult.finalOutput) {
      throw new Error('No orchestration output received');
    }

    // Parse JSON response from orchestration agent
    let taskStatus: any;
    try {
      taskStatus = JSON.parse(orchestrationResult.finalOutput || '{}');
    } catch (e) {
      console.log(`   Debug: Failed to parse orchestration response: ${e}`);
      taskStatus = {
        completed_tasks: [],
        pending_tasks: ['Failed to parse orchestration response'],
        current_task: null,
        selected_tools: ['calculator'],
        tool_reasoning: 'Fallback due to parse error',
        is_complete: false
      };
    }
    inputItems = orchestrationResult.history;

    // Display TODO List with simple formatting
    console.log(`
>> 📋 CURRENT TODO LIST
    
✅ COMPLETED:`);
    if (taskStatus.completed_tasks.length === 0) {
      console.log(`   • None yet`);
    } else {
      taskStatus.completed_tasks.forEach((task: string, i: number) => {
        console.log(`   ${i + 1}. ${task}`);
      });
    }
    
    console.log(`
⏳ PENDING:`);
    if (taskStatus.pending_tasks.length === 0) {
      console.log(`   • None remaining`);
    } else {
      taskStatus.pending_tasks.forEach((task: string, i: number) => {
        console.log(`   ${i + 1}. ${task}`);
      });
    }
    
    console.log(`
🎯 CURRENT FOCUS:`);
    const currentTask = taskStatus.current_task || 'None';
    console.log(`   • ${currentTask}`);
    console.log(`-------------------------------------------------------------------`);

    // Check if we're done
    if (taskStatus.is_complete) {
      console.log(`
>> ✅ COMPLETION STATUS
   All tasks have been completed successfully!
-------------------------------------------------------------------`);
      
      finalAnswer = `Task completed successfully! 

Completed tasks: ${taskStatus.completed_tasks.join(', ')}

Summary: ${taskStatus.next_action || 'All requested operations have been executed.'}`;
      break;
    }

    // Determine tools for current task
    if (taskStatus.current_task) {
      console.log(`
>> 🔧 TOOL SELECTION
   Analyzing task: ${taskStatus.current_task}`);
      
      // Get tool selection from orchestration agent's JSON response
      let selectedToolNames: string[] = ['calculator']; // Default fallback
      let reasoning = 'Using default fallback - no tools specified';
      
      if (taskStatus.selected_tools && Array.isArray(taskStatus.selected_tools)) {
        selectedToolNames = taskStatus.selected_tools;
        reasoning = taskStatus.tool_reasoning || 'LLM selected these tools';
        console.log(`   Debug: LLM selected tools successfully`);
      } else {
        console.log(`   Debug: No tool selection in orchestration response, using fallback`);
      }

      console.log(`   Selected tools: ${selectedToolNames.join(', ')}`);
      console.log(`   Reasoning: ${reasoning}`);
      console.log(`-------------------------------------------------------------------`);

      // Filter tools for action agent
      const selectedTools = ALL_TOOLS.filter((tool: any) => 
        selectedToolNames.includes(tool.name)
      );

      if (selectedTools.length === 0) {
        selectedTools.push(calculatorTool);
      }

      // Configure action agent with selected tools
      actionAgent.tools = selectedTools;

      // Action phase: Execute single tool
      console.log(`
>> ⚡ ACTION AGENT
   Executing single tool with focused capabilities...
   Available tools: ${selectedTools.map(t => t.name).join(', ')}`);

      const actionInput = `Execute this specific task: ${taskStatus.current_task}`;
      console.log(`
🤖 LLM CALL STARTING ===================================================
   Agent: Action Agent  
   Purpose: Single tool execution
   Task: ${taskStatus.current_task}
   Available Tools: ${selectedTools.map(t => t.name).join(', ')}
===================================================================`);
      
      const actionStartTime = Date.now();
      let actionResult = await run(actionAgent, [
        { role: 'user', content: actionInput }
      ]);
      const actionDuration = Date.now() - actionStartTime;
      
      console.log(`
✅ LLM CALL COMPLETED =================================================
   Duration: ${actionDuration}ms
   Tool Used: ${(actionResult.newItems.find((item: any) => item.type === 'tool_call_item') as any)?.name || 'Unknown'}
   Response: ${actionResult.finalOutput ? 'Success' : 'No output'}
===================================================================`);

      // Handle approvals if needed
      if (APPROVAL_ENABLED) {
        actionResult = await handleApprovals(actionResult);
      }

      const result = actionResult.finalOutput || 'No result';
      console.log(`   Result: ${result}`);
      console.log(`-------------------------------------------------------------------`);

      // Update conversation with action results
      inputItems.push({
        role: 'user',
        content: `Task "${taskStatus.current_task}" completed with result: ${actionResult.finalOutput}. Update the todo list and continue.`
      });
    } else {
      // No current task, ask for next steps
      inputItems.push({
        role: 'user',
        content: 'No current task specified. Please determine the next action or mark as complete.'
      });
    }
  }

  if (iterations >= MAX_ITERATIONS) {
    console.log(`
>> ⚠️  ITERATION LIMIT REACHED
   Task execution stopped after ${MAX_ITERATIONS} iterations.
   Some tasks may remain incomplete.
-------------------------------------------------------------------`);
    finalAnswer = `Task execution stopped after ${MAX_ITERATIONS} iterations. Some tasks may remain incomplete.`;
  }

  return finalAnswer;
}

// CLI Interface
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const userRequest = await rl.question(
      'What would you like me to help you with? (I can do math, check weather, write files, or set timers): '
    );

    if (!userRequest.trim()) {
      console.log('No request provided. Exiting.');
      return;
    }

    await withTrace('TODO Orchestration Example', async () => {
      const result = await executeTask(userRequest);
      console.log(`
===============================================================================
                             🎉 FINAL RESULT                                  
===============================================================================`);
      
      // Split result into lines and display each one
      const lines = result.split('\n');
      lines.forEach(line => {
        console.log(`${line}`);
      });
      
      console.log(`===============================================================================`);
    });

  } finally {
    rl.close();
    
    // Cleanup
    try {
      await fs.unlink('orchestration-state.json');
    } catch (e) {
      // File doesn't exist, ignore
    }
  }
}

// Run if this is the main module
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}

export { executeTask, orchestrationAgent, actionAgent }; 