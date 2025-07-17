import { Agent, tool, run, AgentInputItem } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';

console.log('=== TODO Orchestration Pattern v5: v3 Logic + v4 Action Agent ===');

// ===== CONFIGURATION =====
const MAX_ITERATIONS = 10;

// ===== TOOL DEFINITIONS =====
const writePoem = tool({
  name: 'write_poem',
  description: 'Creates beautiful poetry based on a given theme',
  parameters: z.object({
    theme: z.string().describe('The theme or topic for the poem')
  }),
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

// ===== ORCHESTRATION AGENT (v3 style logic) =====
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: [
    'You are a creative writing orchestration agent with TODO list management.',
    'AVAILABLE TOOLS: write_poem (needs theme), write_blog_title (needs theme), write_audio_jingle (needs word_count, theme), write_lego_concept (needs theme), format_response (needs content).',
    'IMPORTANT: You ONLY plan and coordinate. You do NOT execute tools yourself.',
    'NEVER mark a task as completed until the action agent has executed it and returned results.',
    'Check if user request has ALL required inputs for selected tools. If missing inputs, set missing_inputs array.',
    'When all inputs are available, set current task and continue=true so action agent can execute.',
    'Only set complete=true after action agent confirms tool execution.',
    'Respond with JSON: {"tasks": {"completed": [], "pending": [], "current": "task"}, "tools": {"selected": ["tool1"], "inputs": {"tool1": {"param": "value"}}, "reasoning": "why"}, "status": {"complete": false, "continue": true, "missing_inputs": []}}'
  ].join(' '),
});

// ===== ACTION AGENT (v4 style - receives tools from orchestrator) =====
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: [
    'You are an action agent that executes exactly ONE creative writing tool per request.',
    'Use the provided tool with the exact parameters given to you.',
    'Execute the tool directly - do not ask for clarification.',
    'Return the creative content generated by the tool.'
  ].join(' '),
  tools: [], // Tools assigned dynamically by orchestrator
  toolUseBehavior: 'stop_on_first_tool',
  modelSettings: { toolChoice: 'required' },
});

// ===== TYPES (from v3) =====
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
• write_audio_jingle - Write catchy jingles (needs: word_count, theme)
• write_lego_concept - Design LEGO kit concepts (needs: theme)
• format_response - Format content in markdown (needs: content)

Multi-tool examples:
• "Write a poem about nature and format it"
• "Create a blog title and jingle for my coffee shop"`;
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

// ===== MAIN ORCHESTRATION LOGIC (v3 style) =====
async function executeWorkflow(userRequest: string): Promise<string> {
  console.log('\n🎯 Starting v5 Orchestration: v3 Logic + v4 Action Agent\n');
  console.log(`👤 User: "${userRequest}"\n`);

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
    
    // ===== ORCHESTRATION PHASE (v3 style) =====
    logSection('🧠 ORCHESTRATION AGENT', 'Analyzing request and planning...');
    
    const orchestrationResult = await run(orchestrationAgent, conversation);
    
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
    
    // ===== ACTION AGENT EXECUTION (v4 style) =====
    logToolSelection(response.tools, response.status);
    
    // Validate and configure tools for action agent
    const selectedTools = response.tools.selected
      .map(name => TOOL_MAP.get(name))
      .filter(tool => tool !== undefined);
    
    if (selectedTools.length === 0) {
      console.log(`   WARNING: No valid tools selected`);
      break;
    }
    
    // Execute each selected tool with v4's action agent pattern
    for (const tool of selectedTools) {
      actionAgent.tools = [tool]; // v4 pattern: assign tool to action agent
      
      logSection('⚡ ACTION AGENT', `Executing ${tool.name}`);
      
      // Get inputs for this specific tool
      const toolInputs = response.tools.inputs[tool.name] || {};
      const inputsText = Object.entries(toolInputs)
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ');
      
      const actionResult = await run(actionAgent, [
        { role: 'user', content: `Use ${tool.name} with these inputs: ${inputsText}` }
      ]);
      
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
🎨 Welcome to v5: Best of v3 + v4!

${getToolDescriptions()}

Try requests like:
• "Write a poem about winter and format it"
• "Create a blog title about productivity"  
• "Write a 10-word jingle for my coffee shop"
• "Design a LEGO set about space exploration"
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