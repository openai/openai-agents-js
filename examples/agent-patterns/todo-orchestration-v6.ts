import { Agent, tool, run, AgentInputItem, extractAllTextOutput } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';

console.log('=== TODO Orchestration Pattern v6: Multi-Tool + Parallel Execution ===');

// ===== CONFIGURATION =====
const APPROVAL_ENABLED = process.env.APPROVAL_ENABLED === 'true' || false;
const MAX_ITERATIONS = 10;

// ===== TOOL DEFINITIONS =====
const writePoem = tool({
  name: 'write_poem',
  description: 'Creates beautiful poetry based on a given theme',
  parameters: z.object({
    theme: z.string().describe('The theme or topic for the poem')
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  async execute({ theme }) {
    return `A beautiful poem about ${theme}:

    In the realm of ${theme}, where dreams take flight,
    Beauty dances in the morning light.
    Each moment holds a story untold,
    A treasure more precious than gold.

    With every breath, we find our way,
    Through the magic of this ${theme} day.`;
  }
});

const writeBlogTitle = tool({
  name: 'write_blog_title', 
  description: 'Generates compelling blog post titles',
  parameters: z.object({
    theme: z.string().describe('The theme or topic for the blog post')
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  async execute({ theme }) {
    const titles = [
      `10 Amazing Ways ${theme} Can Transform Your Life`,
      `The Ultimate Guide to Mastering ${theme} in 2024`, 
      `Why ${theme} is the Secret to Success (And How to Get Started)`,
      `From Beginner to Expert: Your Complete ${theme} Journey`
    ];
    return titles[Math.floor(Math.random() * titles.length)];
  }
});

const writeAudioJingle = tool({
  name: 'write_audio_jingle',
  description: 'Creates short promotional jingles for audio advertising',
  parameters: z.object({
    word_count: z.number().describe('Target word count for the jingle'),
    theme: z.string().describe('The theme or product for the jingle')
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  async execute({ word_count, theme }) {
    const words = [
      'Amazing', 'Fresh', 'New', 'Best', 'Quality', 'Perfect', 'Great', 'Awesome',
      'Delicious', 'Premium', 'Ultimate', 'Incredible', 'Fantastic', 'Wonderful'
    ];
    
    let jingle = '';
    let currentWords = 0;
    
    while (currentWords < word_count - 2) {
      const word = words[Math.floor(Math.random() * words.length)];
      jingle += word + ' ';
      currentWords++;
    }
    
    jingle += `${theme} today!`;
    return jingle.trim();
  }
});

const writeLegoeConcept = tool({
  name: 'write_lego_concept',
  description: 'Designs detailed LEGO kit concepts',
  parameters: z.object({
    theme: z.string().describe('The theme for the LEGO set')
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  async execute({ theme }) {
    return `🧱 LEGO ${theme.toUpperCase()} ADVENTURE SET

    Set Details:
    - Pieces: 847
    - Ages: 8-14
    - Minifigures: 4 unique characters
    
    Features:
    - Interactive ${theme} environment with moving parts
    - Hidden compartments and secret mechanisms  
    - Compatible with other LEGO sets for expanded play
    - Includes exclusive ${theme}-themed accessories
    
    Build, play, and explore the world of ${theme}!`;
  }
});

const formatResponse = tool({
  name: 'format_response',
  description: 'Formats content into clean markdown',
  parameters: z.object({
    content: z.string().describe('The content to format')
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  async execute({ content }) {
    return `# Formatted Content

${content}

---
*Formatted with markdown styling*`;
  }
});

// ===== ALL AVAILABLE TOOLS =====
const ALL_TOOLS = [writePoem, writeBlogTitle, writeAudioJingle, writeLegoeConcept, formatResponse];
const TOOL_MAP = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));

// ===== ORCHESTRATION AGENT (Enhanced for parallel execution) =====
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: [
    'You are a creative writing orchestration agent with TODO list management and parallel execution capability.',
    'AVAILABLE TOOLS: write_poem (needs theme), write_blog_title (needs theme), write_audio_jingle (needs word_count, theme), write_lego_concept (needs theme), format_response (needs content).',
    'IMPORTANT: You ONLY plan and coordinate. You do NOT execute tools yourself.',
    'SEQUENTIAL TOOLS: When one tool needs output from another (e.g., write_poem then format_response)',
    'PARALLEL TOOLS: When tools are independent and can run simultaneously (e.g., write_blog_title and write_audio_jingle)',
    'CRITICAL: For sequential tools, provide ALL inputs for ALL tools. For format_response, set content:"<from_previous_tool>" as a placeholder.',
    'Respond with JSON: {"tasks": {"completed": [], "pending": [], "current_batch": []}, "tools": {"sequential_groups": [[tool1], [tool2]], "parallel_group": [tool3, tool4], "inputs": {"tool1": {"param": "value"}, "tool2": {"param": "value"}}, "reasoning": "why"}, "status": {"complete": false, "continue": true, "missing_inputs": [], "execution_mode": "sequential|parallel"}}',
    'Mark tasks as completed ONLY after action agent confirms execution. Never mark tasks complete until they are actually executed.',
    'ENSURE all tools in sequential_groups and parallel_group have corresponding entries in inputs object with all required parameters.'
  ].join(' '),
});

// ===== ACTION AGENT (Enhanced for parallel execution) =====
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: [
    'You are an action agent that executes creative writing tools.',
    'For SEQUENTIAL mode: Execute exactly ONE tool per request.',
    'For PARALLEL mode: You will receive multiple tool assignments to execute simultaneously.',
    'Use the provided tools with the exact parameters given to you.',
    'Execute tools directly - do not ask for clarification.',
    'Return the creative content generated by the tools.'
  ].join(' '),
  tools: [], // Tools assigned dynamically by orchestrator
  toolUseBehavior: 'stop_on_first_tool',
  modelSettings: { toolChoice: 'required' },
});

// ===== TYPES (Enhanced for parallel execution) =====
interface TaskState {
  completed: string[];
  pending: string[];
  current_batch: string[];
}

interface ToolSelection {
  sequential_groups?: string[][];
  parallel_group?: string[];
  inputs: Record<string, Record<string, any>>;
  reasoning: string;
}

interface ExecutionStatus {
  complete: boolean;
  continue: boolean;
  missing_inputs: string[];
  execution_mode: 'sequential' | 'parallel';
}

interface OrchestrationResponse {
  tasks: TaskState;
  tools: ToolSelection;
  status: ExecutionStatus;
}

// ===== HELPER FUNCTIONS =====
function getToolDescriptions(): string {
  return `
Available Creative Tools:
• write_poem - Create beautiful poetry (needs: theme)
• write_blog_title - Generate compelling blog titles (needs: theme)  
• write_audio_jingle - Write catchy jingles (needs: word_count, theme)
• write_lego_concept - Design LEGO kit concepts (needs: theme)
• format_response - Format content in markdown (needs: content)

Multi-tool examples:
• "Write a poem about nature and format it" (SEQUENTIAL - format needs poem)
• "Create a blog title and jingle for my coffee shop" (PARALLEL - independent tasks)`;
}

function logSection(title: string, content?: string) {
  console.log(`\n>> ${title}`);
  if (content) {
    console.log(`   ${content}`);
  }
}

function logTaskState(tasks: TaskState) {
  logSection('📋 TODO LIST');
  
  console.log(`\n✅ COMPLETED:`);
  if (tasks.completed.length === 0) {
    console.log(`   • None yet`);
  } else {
    tasks.completed.forEach((task, i) => {
      console.log(`   ${i + 1}. ${task}`);
    });
  }

  console.log(`\n⏳ PENDING:`);
  if (tasks.pending.length === 0) {
    console.log(`   • None remaining`);
  } else {
    tasks.pending.forEach((task, i) => {
      console.log(`   ${i + 1}. ${task}`);
    });
  }

  console.log(`\n🎯 CURRENT BATCH:`);
  if (tasks.current_batch.length === 0) {
    console.log(`   • None`);
  } else {
    tasks.current_batch.forEach((task, i) => {
      console.log(`   ${i + 1}. ${task}`);
    });
  }
}

function logToolSelection(tools: ToolSelection, status: ExecutionStatus) {
  logSection('🔧 TOOL SELECTION');
  
  if (status.execution_mode === 'parallel' && tools.parallel_group) {
    console.log(`   🚀 PARALLEL: ${tools.parallel_group.join(', ')}`);
  } else if (tools.sequential_groups) {
    console.log(`   ⏭️  SEQUENTIAL: ${tools.sequential_groups.flat().join(' → ')}`);
  }
  
  console.log(`   Reasoning: ${tools.reasoning}`);
  
  if (status.missing_inputs.length > 0) {
    console.log(`   ⚠️  Missing inputs: ${status.missing_inputs.join(', ')}`);
  }
  
  if (Object.keys(tools.inputs).length > 0) {
    console.log(`   📝 Tool inputs:`);
    Object.entries(tools.inputs).forEach(([tool, params]) => {
      console.log(`      ${tool}: ${JSON.stringify(params)}`);
    });
  }
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
    await fs.writeFile('state.json', JSON.stringify(currentResult.state, null, 2));
    
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
    
    console.log(`🤖 LLM CALL STARTING (Resume) ===================================`);
    currentResult = await run(actionAgent, state);
    console.log(`✅ LLM CALL COMPLETED ========================================`);
  }
  
  return currentResult;
}

// ===== PARALLEL EXECUTION FUNCTIONS =====
async function executeToolsInParallel(toolNames: string[], toolInputs: Record<string, Record<string, any>>): Promise<Record<string, string>> {
  logSection('🚀 PARALLEL EXECUTION', `Running ${toolNames.length} tools simultaneously`);
  
  // Create separate action agents for parallel execution
  const parallelPromises = toolNames.map(async (toolName) => {
    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }
    
    // Create a dedicated action agent for this tool
    const parallelActionAgent = new Agent({
      name: `action_agent_${toolName}`,
      instructions: actionAgent.instructions,
      tools: [tool],
      toolUseBehavior: 'stop_on_first_tool',
      modelSettings: { toolChoice: 'required' },
    });
    
    const inputs = toolInputs[toolName] || {};
    const inputsText = Object.entries(inputs)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    
    console.log(`   🔧 Starting ${toolName} with inputs: ${inputsText}`);
    
    let result = await run(parallelActionAgent, [
      { role: 'user', content: `Use ${toolName} with these inputs: ${inputsText}` }
    ]);
    
    // Handle approvals if needed
    if (APPROVAL_ENABLED) {
      result = await handleApprovals(result);
    }
    
    return { toolName, result: result.finalOutput || 'No result' };
  });
  
  const results = await Promise.all(parallelPromises);
  
  // Convert to record format
  const resultMap: Record<string, string> = {};
  results.forEach(({ toolName, result }) => {
    resultMap[toolName] = result;
    console.log(`   ✅ ${toolName} completed`);
  });
  
  return resultMap;
}

async function executeToolSequentially(toolName: string, toolInputs: Record<string, Record<string, any>>): Promise<string> {
  logSection('⏭️ SEQUENTIAL EXECUTION', `Executing ${toolName}`);
  
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    throw new Error(`Tool ${toolName} not found`);
  }
  
  actionAgent.tools = [tool];
  
  const inputs = toolInputs[toolName] || {};
  const inputsText = Object.entries(inputs)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  
  let actionResult = await run(actionAgent, [
    { role: 'user', content: `Use ${toolName} with these inputs: ${inputsText}` }
  ]);
  
  // Handle approvals if needed
  if (APPROVAL_ENABLED) {
    actionResult = await handleApprovals(actionResult);
  }
  
  return actionResult.finalOutput || 'No result';
}

// ===== MAIN ORCHESTRATION LOGIC (Enhanced) =====
async function executeWorkflow(userRequest: string): Promise<string> {
  console.log('\n🎯 Starting v6 Orchestration: Multi-Tool + Parallel Execution\n');
  console.log(`👤 User: "${userRequest}"`);
  console.log(`🎛️  Mode: ${APPROVAL_ENABLED ? 'APPROVAL ENABLED' : 'AUTO EXECUTION'}\n`);

  // Show available tools if user asks what we can do
  if (userRequest.toLowerCase().includes('what') && (userRequest.toLowerCase().includes('can') || userRequest.toLowerCase().includes('do'))) {
    console.log(getToolDescriptions());
  }

  let conversation: AgentInputItem[] = [{ role: 'user', content: userRequest }];
  let iteration = 0;
  let generatedContent: Record<string, string> = {};
  
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    logSection(`🔄 ITERATION ${iteration}`);
    
    // ===== ORCHESTRATION PHASE =====
    logSection('🧠 ORCHESTRATION AGENT', 'Analyzing request and planning...');
    
    const orchestrationResult = await run(orchestrationAgent, conversation);
    
    // Parse orchestration response
    let response: OrchestrationResponse;
    try {
      response = JSON.parse(orchestrationResult.finalOutput || '{}');
    } catch (e) {
      console.log(`   ERROR: Failed to parse orchestration response: ${e}`);
      response = {
        tasks: { completed: [], pending: ['Parse error occurred'], current_batch: [] },
        tools: { inputs: {}, reasoning: 'Parse error occurred' },
        status: { complete: false, continue: false, missing_inputs: [], execution_mode: 'sequential' }
      };
    }
    
    conversation = orchestrationResult.history;
    logTaskState(response.tasks);
    
    // Check if complete
    if (response.status.complete) {
      logSection('✅ WORKFLOW COMPLETE', 'All creative tasks finished!');
      break;
    }
    
    // Check for missing inputs
    if (response.status.missing_inputs.length > 0) {
      logSection('⚠️  MISSING INPUTS', `Need: ${response.status.missing_inputs.join(', ')}`);
      
      // Ask user for missing inputs
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      
      console.log(`\nPlease provide the missing information:`);
      for (const input of response.status.missing_inputs) {
        const value = await rl.question(`${input}: `);
        conversation.push({
          role: 'user',
          content: `Provided ${input}: ${value}. Now proceed with tool execution.`
        });
      }
      rl.close();
      continue;
    }
    
    // Check if we should continue
    if (!response.status.continue) {
      logSection('⏸️  WORKFLOW PAUSED', 'No tasks to execute');
      break;
    }
    
    // ===== ACTION AGENT EXECUTION =====
    logToolSelection(response.tools, response.status);
    
    // Execute tools based on mode
    if (response.status.execution_mode === 'parallel' && response.tools.parallel_group) {
      // PARALLEL EXECUTION
      const parallelResults = await executeToolsInParallel(
        response.tools.parallel_group,
        response.tools.inputs
      );
      
      // Store all parallel results
      Object.assign(generatedContent, parallelResults);
      
      // Log results
      Object.entries(parallelResults).forEach(([toolName, result]) => {
        console.log(`\n🎨 ${toolName.toUpperCase()} RESULT:\n${result}\n`);
      });
      
      // Add results to conversation
      const resultsText = Object.entries(parallelResults)
        .map(([tool, result]) => `${tool}: ${result}`)
        .join('\n\n');
      
      conversation.push({
        role: 'user',
        content: `Action agent successfully executed ${response.tools.parallel_group.join(', ')} in parallel. Results: ${resultsText}. Mark these tasks as completed.`
      });
      
         } else if (response.tools.sequential_groups) {
       // SEQUENTIAL EXECUTION
       for (const group of response.tools.sequential_groups) {
         for (const toolName of group) {
           // Before executing, check if this tool needs output from previous tool
           const toolInputs = { ...response.tools.inputs };
           
           // Replace placeholder content with actual previous tool output
           if (toolName === 'format_response' && toolInputs[toolName]?.content === '<from_previous_tool>') {
             // Find the most recent non-format tool result as content
             const contentSources = ['write_poem', 'write_blog_title', 'write_audio_jingle', 'write_lego_concept'];
             for (const source of contentSources) {
               if (generatedContent[source]) {
                 toolInputs[toolName].content = generatedContent[source];
                 break;
               }
             }
           }
           
           const result = await executeToolSequentially(toolName, toolInputs);
           
           generatedContent[toolName] = result;
           console.log(`\n🎨 ${toolName.toUpperCase()} RESULT:\n${result}\n`);
         }
       }
      
      // Add results to conversation  
      conversation.push({
        role: 'user',
        content: `Action agent successfully executed tools sequentially. Mark completed tasks and check if workflow is done.`
      });
    }
  }
  
  if (iteration >= MAX_ITERATIONS) {
    logSection('⚠️  ITERATION LIMIT', `Stopped after ${MAX_ITERATIONS} iterations`);
  }
  
  return Object.values(generatedContent).join('\n\n---\n\n');
}

// ===== CLI INTERFACE =====
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(`
🎨 Welcome to v6: Multi-Tool + Parallel Execution!

${getToolDescriptions()}

Try requests like:
• "Write a poem about winter and format it" (Sequential)
• "Create a blog title and jingle for my coffee shop" (Parallel)  
• "Design a LEGO set about space and write a blog title about it" (Parallel)
• "Write a poem about nature, then format it nicely" (Sequential)
`);

    const userRequest = await rl.question('What would you like me to help you create? ');

    if (!userRequest.trim()) {
      console.log('No request provided. Exiting.');
      return;
    }

    const result = await executeWorkflow(userRequest);
    
    console.log('\n===============================================================================');
    console.log('🎉 FINAL OUTPUT');
    console.log('===============================================================================');
    console.log(result);
    console.log('===============================================================================');

  } finally {
    rl.close();
    
    // Cleanup state file
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