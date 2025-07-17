import {
  Agent,
  run,
  tool,
  withTrace,
  AgentInputItem,
} from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';

// ===== CONFIGURATION =====
const APPROVAL_ENABLED = process.env.APPROVAL_ENABLED === 'true' || false;
const MAX_ITERATIONS = 8;

// ===== SAMPLE TOOLS =====
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
      case 'add': result = a + b; break;
      case 'subtract': result = a - b; break;
      case 'multiply': result = a * b; break;
      case 'divide': result = b !== 0 ? a / b : NaN; break;
    }
    return `${a} ${operation} ${b} = ${result}`;
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
      return `Successfully wrote to ${filename}`;
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

// ===== TOOL REGISTRY =====
const ALL_TOOLS = [calculatorTool, weatherTool, fileWriterTool, timerTool];
const TOOL_MAP = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));

// ===== ORCHESTRATION AGENT =====
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: [
    'You are an orchestration agent that manages tasks and coordinates execution.',
    'Break down user requests into specific, actionable tasks.',
    'Available tools: calculator (math), get_weather (weather info), write_file (save files), timer (set timers).',
    'For each task, select appropriate tools and provide clear reasoning.',
    'Always respond with valid JSON in this exact format:',
    '{"tasks": {"completed": ["task1"], "pending": ["task2"], "current": "task3"}, "tools": {"selected": ["tool1"], "reasoning": "why"}, "status": {"complete": false, "continue": true}}'
  ].join(' '),
});

// ===== ACTION AGENT =====
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: [
    'You are an action agent that executes exactly ONE tool per request.',
    'Use the provided tool to complete the specific task.',
    'Be direct and focused - execute the tool with appropriate parameters.',
    'Do not make multiple tool calls or ask for clarification.'
  ].join(' '),
  tools: [], // Tools assigned dynamically
  toolUseBehavior: 'stop_on_first_tool',
  modelSettings: { toolChoice: 'required' },
});

// ===== TYPES =====
interface TaskState {
  completed: string[];
  pending: string[];
  current: string | null;
}

interface ToolSelection {
  selected: string[];
  reasoning: string;
}

interface ExecutionStatus {
  complete: boolean;
  continue: boolean;
}

interface OrchestrationResponse {
  tasks: TaskState;
  tools: ToolSelection;
  status: ExecutionStatus;
}

// ===== HUMAN APPROVAL SYSTEM =====
async function askApproval(toolName: string, args: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`
>> 🤝 HUMAN APPROVAL REQUIRED
   Tool: ${toolName}
   Arguments: ${args}
===================================================================`);

  const answer = await rl.question('Approve this tool execution? (y/n): ');
  rl.close();
  
  const approved = answer.toLowerCase().startsWith('y');
  console.log(`
>> 📝 DECISION: ${approved ? 'APPROVED' : 'REJECTED'}
===================================================================`);
  
  return approved;
}

async function handleApprovals(result: any): Promise<any> {
  let currentResult = result;
  
  while (currentResult.interruptions?.length > 0) {
    // Save state
    await fs.writeFile('state.json', JSON.stringify(currentResult.state, null, 2));
    
    // Handle approvals
    const state = await currentResult.state.constructor.fromString(
      actionAgent, 
      await fs.readFile('state.json', 'utf-8')
    );
    
    for (const interruption of currentResult.interruptions) {
      const approved = await askApproval(
        interruption.rawItem.name,
        interruption.rawItem.arguments
      );
      
      if (approved) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }
    
    console.log(`
🤖 LLM CALL STARTING (Resume) =========================================
   Agent: Action Agent
   Purpose: Continue after approval
===================================================================`);
    
    currentResult = await run(actionAgent, state);
    
    console.log(`
✅ LLM CALL COMPLETED ===============================================
   Status: ${currentResult.interruptions?.length > 0 ? 'More approvals needed' : 'Complete'}
===================================================================`);
  }
  
  return currentResult;
}

// ===== CONSOLE OUTPUT =====
function logHeader(title: string) {
  console.log(`
===============================================================================
                              ${title}
===============================================================================`);
}

function logSection(title: string, content?: string) {
  console.log(`
>> ${title}`);
  if (content) {
    console.log(`   ${content}`);
  }
}

function logLLMCall(agent: string, purpose: string, start: boolean = true) {
  const status = start ? 'STARTING' : 'COMPLETED';
  const emoji = start ? '🤖' : '✅';
  
  console.log(`
${emoji} LLM CALL ${status} =============================================
   Agent: ${agent}
   Purpose: ${purpose}`);
  
  if (!start) {
    console.log(`===================================================================`);
  }
}

function logTaskState(tasks: TaskState) {
  console.log(`
>> 📋 TODO LIST

✅ COMPLETED:`);
  if (tasks.completed.length === 0) {
    console.log(`   • None yet`);
  } else {
    tasks.completed.forEach((task, i) => {
      console.log(`   ${i + 1}. ${task}`);
    });
  }

  console.log(`
⏳ PENDING:`);
  if (tasks.pending.length === 0) {
    console.log(`   • None remaining`);
  } else {
    tasks.pending.forEach((task, i) => {
      console.log(`   ${i + 1}. ${task}`);
    });
  }

  console.log(`
🎯 CURRENT FOCUS:`);
  console.log(`   • ${tasks.current || 'None'}`);
  console.log(`===================================================================`);
}

function logToolSelection(tools: ToolSelection) {
  logSection('🔧 TOOL SELECTION');
  console.log(`   Selected: ${tools.selected.join(', ')}`);
  console.log(`   Reasoning: ${tools.reasoning}`);
  console.log(`===================================================================`);
}

// ===== MAIN ORCHESTRATION LOGIC =====
async function executeWorkflow(userRequest: string): Promise<string> {
  logHeader(`🎯 TODO ORCHESTRATION SYSTEM V2`);
  console.log(`Task: ${userRequest}`);
  console.log(`Mode: ${APPROVAL_ENABLED ? 'APPROVAL ENABLED' : 'AUTO EXECUTION'}`);
  console.log(`===============================================================================`);

  let conversation: AgentInputItem[] = [{ role: 'user', content: userRequest }];
  let iteration = 0;
  
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    logSection(`🔄 ITERATION ${iteration}`);
    
    // ===== ORCHESTRATION PHASE =====
    logSection('🧠 ORCHESTRATION AGENT', 'Planning and coordinating...');
    
    logLLMCall('Orchestration Agent', 'Task planning and tool selection', true);
    const startTime = Date.now();
    
    const orchestrationResult = await run(orchestrationAgent, conversation);
    const duration = Date.now() - startTime;
    
    logLLMCall('Orchestration Agent', `Completed in ${duration}ms`, false);
    
    // Parse orchestration response
    let response: OrchestrationResponse;
    try {
      response = JSON.parse(orchestrationResult.finalOutput || '{}');
    } catch (e) {
      console.log(`   ERROR: Failed to parse orchestration response`);
      response = {
        tasks: { completed: [], pending: ['Parse error occurred'], current: null },
        tools: { selected: ['calculator'], reasoning: 'Fallback due to parse error' },
        status: { complete: false, continue: false }
      };
    }
    
    // Update conversation history
    conversation = orchestrationResult.history;
    
    // Display current state
    logTaskState(response.tasks);
    
    // Check if complete
    if (response.status.complete) {
      logSection('✅ WORKFLOW COMPLETE', 'All tasks finished successfully!');
      break;
    }
    
    // Check if we should continue
    if (!response.status.continue || !response.tasks.current) {
      logSection('⏸️  WORKFLOW PAUSED', 'No current task to execute');
      break;
    }
    
    // ===== TOOL SELECTION & ACTION PHASE =====
    logToolSelection(response.tools);
    
    // Validate and configure tools for action agent
    const selectedTools = response.tools.selected
      .map(name => TOOL_MAP.get(name))
      .filter(tool => tool !== undefined);
    
    if (selectedTools.length === 0) {
      console.log(`   WARNING: No valid tools selected, using calculator as fallback`);
      selectedTools.push(calculatorTool);
    }
    
    // Configure action agent
    actionAgent.tools = selectedTools;
    
    logSection('⚡ ACTION AGENT', `Executing with ${selectedTools.length} tool(s)`);
    console.log(`   Available: ${selectedTools.map(t => t.name).join(', ')}`);
    
    // Execute action
    logLLMCall('Action Agent', 'Single tool execution', true);
    const actionStart = Date.now();
    
    let actionResult = await run(actionAgent, [
      { role: 'user', content: `Execute this task: ${response.tasks.current}` }
    ]);
    
    const actionDuration = Date.now() - actionStart;
    logLLMCall('Action Agent', `Completed in ${actionDuration}ms`, false);
    
    // Handle approvals if needed
    if (APPROVAL_ENABLED) {
      actionResult = await handleApprovals(actionResult);
    }
    
    // Log result
    const result = actionResult.finalOutput || 'No result';
    console.log(`   Result: ${result}`);
    console.log(`===================================================================`);
    
    // Add result to conversation
    conversation.push({
      role: 'user',
      content: `Task "${response.tasks.current}" completed with result: ${result}. Update the todo list and continue.`
    });
  }
  
  if (iteration >= MAX_ITERATIONS) {
    logSection('⚠️  ITERATION LIMIT', `Stopped after ${MAX_ITERATIONS} iterations`);
  }
  
  // Generate final summary
  const lastCompleted = conversation
    .filter((item: any) => item.role === 'user')
    .map((item: any) => item.content)
    .join(' ');
  
  return `Workflow completed after ${iteration} iterations. Summary: ${lastCompleted}`;
}

// ===== CLI INTERFACE =====
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const userRequest = await rl.question(
      'What would you like me to help you with? (math, weather, files, timers): '
    );

    if (!userRequest.trim()) {
      console.log('No request provided. Exiting.');
      return;
    }

    await withTrace('TODO Orchestration V2', async () => {
      const result = await executeWorkflow(userRequest);
      
      logHeader('🎉 FINAL RESULT');
      console.log(result);
      console.log(`===============================================================================`);
    });

  } finally {
    rl.close();
    
    // Cleanup
    try {
      await fs.unlink('state.json');
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

// ===== EXECUTION =====
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });
}

export { executeWorkflow, orchestrationAgent, actionAgent }; 