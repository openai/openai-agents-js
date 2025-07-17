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
const MAX_ITERATIONS = 10;

// ===== CREATIVE WRITING AGENTS =====
const poetAgent = new Agent({
  name: 'poet_agent',
  instructions: 'You are a skilled poet. Write beautiful, creative poetry based on the given theme. Make it engaging and emotionally resonant.',
});

const blogTitleAgent = new Agent({
  name: 'blog_title_agent', 
  instructions: 'You are an expert content marketer. Create compelling, click-worthy blog post titles that capture attention and clearly convey value.',
});

const jingleAgent = new Agent({
  name: 'jingle_agent',
  instructions: 'You are a creative copywriter specializing in audio advertising. Write catchy, memorable jingles that are perfect for radio or podcast ads.',
});

const legoConceptAgent = new Agent({
  name: 'lego_concept_agent',
  instructions: 'You are a LEGO set designer. Create detailed, innovative LEGO kit concepts that would be fun to build and play with.',
});

const markdownFormatterAgent = new Agent({
  name: 'markdown_formatter_agent',
  instructions: 'You are a technical writer. Format the given content into clean, well-structured markdown with appropriate headers, emphasis, and formatting.',
});

// ===== CREATIVE WRITING TOOLS =====
const writePoemTool = tool({
  name: 'write_poem',
  description: 'Write a creative poem based on a given theme',
  parameters: z.object({
    theme: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ theme }: { theme: string }) => {
    console.log(`   🎭 Generating poem with theme: "${theme}"`);
    const result = await run(poetAgent, `Write a beautiful poem about ${theme}. Make it creative and emotionally engaging.`);
    return result.finalOutput || 'Unable to generate poem';
  },
});

const writeBlogTitleTool = tool({
  name: 'write_blog_title',
  description: 'Generate compelling blog post titles for a given theme',
  parameters: z.object({
    theme: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ theme }: { theme: string }) => {
    console.log(`   📝 Generating blog title for theme: "${theme}"`);
    const result = await run(blogTitleAgent, `Create 3 compelling blog post titles about ${theme}. Make them click-worthy and valuable to readers.`);
    return result.finalOutput || 'Unable to generate blog titles';
  },
});

const writeAudioJingleTool = tool({
  name: 'write_audio_jingle',
  description: 'Write a catchy audio jingle with specified word count',
  parameters: z.object({
    word_count: z.number(),
    theme: z.string().nullable().optional(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ word_count, theme }: { word_count: number, theme?: string | null }) => {
    const themeText = theme ? ` about ${theme}` : '';
    console.log(`   🎵 Generating ${word_count}-word jingle${themeText}`);
    const prompt = `Write a catchy, memorable jingle${themeText} that is exactly ${word_count} words long. Make it rhythmic and perfect for audio advertising.`;
    const result = await run(jingleAgent, prompt);
    return result.finalOutput || 'Unable to generate jingle';
  },
});

const writeLegoConceptTool = tool({
  name: 'write_lego_concept',
  description: 'Design a creative LEGO kit concept based on a theme',
  parameters: z.object({
    theme: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ theme }: { theme: string }) => {
    console.log(`   🧱 Designing LEGO concept for theme: "${theme}"`);
    const prompt = `Design a detailed LEGO kit concept based on ${theme}. Include the set name, piece count, key features, minifigures, and what makes it fun to build and play with.`;
    const result = await run(legoConceptAgent, prompt);
    return result.finalOutput || 'Unable to generate LEGO concept';
  },
});

const formatResponseTool = tool({
  name: 'format_response',
  description: 'Format content into clean, well-structured markdown',
  parameters: z.object({
    content: z.string(),
  }),
  needsApproval: APPROVAL_ENABLED ? async () => true : undefined,
  execute: async ({ content }: { content: string }) => {
    console.log(`   📋 Formatting content into markdown...`);
    const prompt = `Format this content into clean, well-structured markdown with appropriate headers, emphasis, lists, and formatting:\n\n${content}`;
    const result = await run(markdownFormatterAgent, prompt);
    return result.finalOutput || 'Unable to format content';
  },
});

// ===== TOOL REGISTRY =====
const ALL_TOOLS = [writePoemTool, writeBlogTitleTool, writeAudioJingleTool, writeLegoConceptTool, formatResponseTool];
const TOOL_MAP = new Map(ALL_TOOLS.map(tool => [tool.name, tool]));

// ===== ORCHESTRATION AGENT =====
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: [
    'You are a creative writing orchestration agent.',
    'AVAILABLE TOOLS: write_poem (needs theme), write_blog_title (needs theme), write_audio_jingle (needs word_count, optional theme), write_lego_concept (needs theme), format_response (needs content).',
    'IMPORTANT: You ONLY plan and coordinate. You do NOT execute tools yourself.',
    'NEVER mark a task as completed until the action agent has executed it and returned results.',
    'Check if user request has ALL required inputs for selected tools. If missing inputs, set missing_inputs array.',
    'When all inputs are available, set current task and continue=true so action agent can execute.',
    'Only set complete=true after action agent confirms tool execution.',
    'Respond with JSON: {"tasks": {"completed": [], "pending": [], "current": "task"}, "tools": {"selected": ["tool1"], "inputs": {"tool1": {"param": "value"}}, "reasoning": "why"}, "status": {"complete": false, "continue": true, "missing_inputs": []}}'
  ].join(' '),
});

// ===== ACTION AGENT =====
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: [
    'You are an action agent that executes exactly ONE creative writing tool per request.',
    'Use the provided tool with the exact parameters given to you.',
    'Execute the tool directly - do not ask for clarification.',
    'Return the creative content generated by the tool.'
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
  inputs: Record<string, Record<string, any>>;
  reasoning: string;
}

interface ExecutionStatus {
  complete: boolean;
  continue: boolean;
  missing_inputs: string[];
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
• write_audio_jingle - Write catchy jingles (needs: word_count, optional: theme)
• write_lego_concept - Design LEGO kit concepts (needs: theme)
• format_response - Format content in markdown (needs: content)

Multi-tool examples:
• "Write a poem about nature and format it"
• "Create a blog title and jingle for my coffee shop"`;
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

// ===== CONSOLE OUTPUT =====
function logHeader(title: string) {
  console.log(`
===============================================================================
                              ${title}
===============================================================================`);
}

function logSection(title: string, content?: string) {
  console.log(`\n>> ${title}`);
  if (content) {
    console.log(`   ${content}`);
  }
}

function logLLMCall(agent: string, purpose: string, duration?: number) {
  if (duration) {
    console.log(`✅ LLM CALL COMPLETED - ${agent}: ${purpose} (${duration}ms)`);
  } else {
    console.log(`🤖 LLM CALL STARTING - ${agent}: ${purpose}`);
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

  console.log(`\n🎯 CURRENT FOCUS:`);
  console.log(`   • ${tasks.current || 'None'}`);
}

function logToolSelection(tools: ToolSelection, status: ExecutionStatus) {
  logSection('🔧 TOOL SELECTION');
  console.log(`   Selected: ${tools.selected.join(', ')}`);
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

// ===== MAIN ORCHESTRATION LOGIC =====
async function executeWorkflow(userRequest: string): Promise<string> {
  logHeader(`🎨 CREATIVE WRITING ORCHESTRATION V3`);
  console.log(`Request: ${userRequest}`);
  console.log(`Mode: ${APPROVAL_ENABLED ? 'APPROVAL ENABLED' : 'AUTO EXECUTION'}`);

  // Show available tools if user asks what we can do
  if (userRequest.toLowerCase().includes('what') && (userRequest.toLowerCase().includes('can') || userRequest.toLowerCase().includes('do'))) {
    console.log(getToolDescriptions());
  }

  let conversation: AgentInputItem[] = [{ role: 'user', content: userRequest }];
  let iteration = 0;
  let generatedContent: string[] = [];
  
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    logSection(`🔄 ITERATION ${iteration}`);
    
    // ===== ORCHESTRATION PHASE =====
    logSection('🧠 ORCHESTRATION AGENT', 'Analyzing request and planning...');
    
    logLLMCall('Orchestration Agent', 'Task planning and input validation');
    const startTime = Date.now();
    
    const orchestrationResult = await run(orchestrationAgent, conversation);
    const duration = Date.now() - startTime;
    
    logLLMCall('Orchestration Agent', 'Planning complete', duration);
    
    // Parse orchestration response
    let response: OrchestrationResponse;
    try {
      response = JSON.parse(orchestrationResult.finalOutput || '{}');
    } catch (e) {
      console.log(`   ERROR: Failed to parse orchestration response: ${e}`);
      response = {
        tasks: { completed: [], pending: ['Parse error occurred'], current: null },
        tools: { selected: [], inputs: {}, reasoning: 'Parse error occurred' },
        status: { complete: false, continue: false, missing_inputs: [] }
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
    if (!response.status.continue || !response.tasks.current) {
      logSection('⏸️  WORKFLOW PAUSED', 'No current task to execute');
      break;
    }
    
    // ===== TOOL SELECTION & ACTION PHASE =====
    logToolSelection(response.tools, response.status);
    
    // Validate and configure tools for action agent
    const selectedTools = response.tools.selected
      .map(name => TOOL_MAP.get(name))
      .filter(tool => tool !== undefined);
    
    if (selectedTools.length === 0) {
      console.log(`   WARNING: No valid tools selected`);
      break;
    }
    
    // Execute each selected tool
    for (const tool of selectedTools) {
      actionAgent.tools = [tool];
      
      logSection('⚡ ACTION AGENT', `Executing ${tool.name}`);
      
      // Get inputs for this specific tool
      const toolInputs = response.tools.inputs[tool.name] || {};
      const inputsText = Object.entries(toolInputs)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      
      logLLMCall('Action Agent', `${tool.name} execution`);
      const actionStart = Date.now();
      
      let actionResult = await run(actionAgent, [
        { role: 'user', content: `Use ${tool.name} with these inputs: ${inputsText}` }
      ]);
      
      const actionDuration = Date.now() - actionStart;
      logLLMCall('Action Agent', `${tool.name} complete`, actionDuration);
      
      // Handle approvals if needed
      if (APPROVAL_ENABLED) {
        actionResult = await handleApprovals(actionResult);
      }
      
      // Store generated content
      const result = actionResult.finalOutput || 'No result';
      generatedContent.push(result);
      console.log(`\n🎨 GENERATED CONTENT:\n${result}\n`);
      
             // Add result to conversation for next iteration
       conversation.push({
         role: 'user',
         content: `Action agent successfully executed ${tool.name} and generated content. Mark this task as completed and check if workflow is done.`
       });
    }
    
         // Update conversation with completion status
     conversation.push({
       role: 'user',
       content: `All selected tools have been executed. Update todo list to mark tasks as completed.`
     });
  }
  
  if (iteration >= MAX_ITERATIONS) {
    logSection('⚠️  ITERATION LIMIT', `Stopped after ${MAX_ITERATIONS} iterations`);
  }
  
  return generatedContent.join('\n\n---\n\n');
}

// ===== CLI INTERFACE =====
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log(`
🎨 Welcome to Creative Writing Orchestration!

Available tools:
• write_poem - Create beautiful poetry  
• write_blog_title - Generate compelling blog titles
• write_audio_jingle - Write catchy jingles
• write_lego_concept - Design LEGO kit concepts  
• format_response - Format content in markdown

Try requests like:
• "Write a poem about winter and format it"
• "Create a blog title about productivity"  
• "Write a 10-word jingle for my coffee shop"
`);

    const userRequest = await rl.question('What creative content would you like me to help you with? ');

    if (!userRequest.trim()) {
      console.log('No request provided. Exiting.');
      return;
    }

    await withTrace('Creative Writing Orchestration V3', async () => {
      const result = await executeWorkflow(userRequest);
      
      logHeader('🎉 FINAL CREATIVE OUTPUT');
      console.log(result);
      console.log(`\n===============================================================================`);
    });

  } finally {
    rl.close();
    
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