import { Agent, tool, run } from '@openai/agents';
import { z } from 'zod';
import readline from 'node:readline/promises';

console.log('=== TODO Orchestration Pattern v4: Orchestrator/Action System ===');

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

// ===== ORCHESTRATION AGENT =====
const orchestrationAgent = new Agent({
  name: 'orchestration_agent',
  instructions: `You are the Orchestration Agent. Your role is to:

1. **Understand the user's request** and break it down into tasks
2. **Select appropriate tools** from the available tools for each task  
3. **Gather all required inputs** for those tools from the user
4. **Create a plan** with tools and their inputs for the Action Agent
5. **Manage the workflow** and decide when to continue or finish

Available tools: write_poem (Creates beautiful poetry), write_blog_title (Generates compelling blog post titles), write_audio_jingle (Creates promotional jingles), write_lego_concept (Designs LEGO kit concepts), format_response (Formats content into markdown)

When you have identified what tools are needed and gathered all inputs, respond with:
- A clear plan of what tools to use
- All the required inputs for those tools
- A message to hand off to the Action Agent

DO NOT execute tools yourself - that's the Action Agent's job. Focus on planning and coordination.

If the user's request requires multiple tools (like "write a poem and format it"), plan the sequence and we'll execute them one by one.`
});

// ===== ACTION AGENT =====  
const actionAgent = new Agent({
  name: 'action_agent',
  instructions: `You are the Action Agent. Your role is to:

1. **Execute the specific tools** given to you by the Orchestration Agent
2. **Use the exact inputs** provided by the Orchestration Agent
3. **Return the results** so the Orchestration Agent can continue coordination

You will receive:
- Specific tools to use
- All required inputs for those tools
- Clear instructions on what to execute

Execute the tools as instructed and return the results. Do not make decisions about what tools to use or how to modify inputs - just execute what you're given.`,
  tools: [] // Tools will be set dynamically by orchestrator
});

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

// ===== MAIN EXECUTION =====
async function executeWorkflow(initialRequest: string): Promise<string> {
  console.log('\n🎯 Starting Orchestration Demo...\n');
  console.log(`👤 User: "${initialRequest}"\n`);
  
  let userRequest = initialRequest;
  
  // Step 1: Orchestration Agent analyzes request and identifies what's needed
  console.log('🧠 ORCHESTRATION AGENT - Analyzing Request');
  const analysisPrompt = `Analyze this request: "${userRequest}"

Identify:
1. What tools are needed from: write_poem, write_blog_title, write_audio_jingle, write_lego_concept, format_response
2. What inputs are required for each tool
3. What inputs are missing from the user's request

Respond in this format:
NEEDED TOOLS: [list tools]
REQUIRED INPUTS: [list what each tool needs]
MISSING INPUTS: [list what user didn't provide]`;

  const analysis = await run(orchestrationAgent, analysisPrompt);
  console.log('📋 Analysis:');
  console.log(analysis.finalOutput);
  
  // Check if we need to gather missing inputs
  if (analysis.finalOutput?.toLowerCase().includes('missing') && 
      !analysis.finalOutput?.toLowerCase().includes('missing inputs: none')) {
    
    console.log('\n⚠️  GATHERING MISSING INPUTS');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    // Extract missing inputs and ask user for them
    const missingInputsMatch = analysis.finalOutput?.match(/MISSING INPUTS?:\s*(.+?)(?:\n|$)/i);
    if (missingInputsMatch) {
      const missingInputs = missingInputsMatch[1];
      console.log(`Missing: ${missingInputs}`);
      
      // Ask for each missing input
      const additionalInput = await rl.question('Please provide the missing information: ');
      userRequest += ` ${additionalInput}`;
      console.log(`\nUpdated request: "${userRequest}"`);
    }
    
    rl.close();
  }
  
  // Step 2: Create execution plan
  console.log('\n🔧 ORCHESTRATION AGENT - Creating Execution Plan');
  const planPrompt = `Create a specific execution plan for: "${userRequest}"

Based on available tools, create a step-by-step plan with exact tool calls and inputs.
Format as: TOOL_NAME(parameter=value)

Example: write_poem(theme=winter) → format_response(content=<poem_output>)`;

  const plan = await run(orchestrationAgent, planPrompt);
  console.log('🎯 Execution Plan:');
  console.log(plan.finalOutput);
  
  let generatedContent: string[] = [];
  
  // Step 3: Execute tools based on the plan
  // For demo purposes, let's handle the most common patterns
  
  if (userRequest.toLowerCase().includes('poem') && userRequest.toLowerCase().includes('format')) {
    // Execute poem + format workflow
    console.log('\n⚡ ACTION AGENT - Executing write_poem');
    actionAgent.tools = [writePoem];
    actionAgent.modelSettings = { toolChoice: 'required' };
    
    // Extract theme from request
    const themeMatch = userRequest.match(/(?:about|poem about|theme[:\s]+)([^,\.\!]+)/i);
    const theme = themeMatch ? themeMatch[1].trim() : 'general';
    
    const poemResult = await run(actionAgent, `Execute write_poem with theme="${theme}"`);
    console.log('📝 Poem Result:');
    console.log(poemResult.finalOutput);
    generatedContent.push(poemResult.finalOutput || '');
    
    console.log('\n⚡ ACTION AGENT - Executing format_response');
    actionAgent.tools = [formatResponse];
    
    const formatResult = await run(actionAgent, `Execute format_response with content="${poemResult.finalOutput}"`);
    console.log('✨ Formatted Result:');
    console.log(formatResult.finalOutput);
    generatedContent.push(formatResult.finalOutput || '');
    
  } else if (userRequest.toLowerCase().includes('blog')) {
    // Execute blog title
    console.log('\n⚡ ACTION AGENT - Executing write_blog_title');
    actionAgent.tools = [writeBlogTitle];
    actionAgent.modelSettings = { toolChoice: 'required' };
    
    const themeMatch = userRequest.match(/(?:about|title about|theme[:\s]+)([^,\.\!]+)/i);
    const theme = themeMatch ? themeMatch[1].trim() : 'general';
    
    const titleResult = await run(actionAgent, `Execute write_blog_title with theme="${theme}"`);
    console.log('📝 Blog Title Result:');
    console.log(titleResult.finalOutput);
    generatedContent.push(titleResult.finalOutput || '');
    
  } else if (userRequest.toLowerCase().includes('jingle')) {
    // Execute jingle
    console.log('\n⚡ ACTION AGENT - Executing write_audio_jingle');
    actionAgent.tools = [writeAudioJingle];
    actionAgent.modelSettings = { toolChoice: 'required' };
    
    const wordCountMatch = userRequest.match(/(\d+)[- ]?word/i);
    const word_count = wordCountMatch ? parseInt(wordCountMatch[1]) : 10;
    
    const themeMatch = userRequest.match(/(?:about|for|theme[:\s]+)([^,\.\!]+)/i);
    const theme = themeMatch ? themeMatch[1].trim() : 'general';
    
    const jingleResult = await run(actionAgent, `Execute write_audio_jingle with word_count=${word_count} and theme="${theme}"`);
    console.log('🎵 Jingle Result:');
    console.log(jingleResult.finalOutput);
    generatedContent.push(jingleResult.finalOutput || '');
    
  } else if (userRequest.toLowerCase().includes('lego')) {
    // Execute LEGO concept
    console.log('\n⚡ ACTION AGENT - Executing write_lego_concept');
    actionAgent.tools = [writeLegoeConcept];
    actionAgent.modelSettings = { toolChoice: 'required' };
    
    const themeMatch = userRequest.match(/(?:about|concept about|theme[:\s]+)([^,\.\!]+)/i);
    const theme = themeMatch ? themeMatch[1].trim() : 'general';
    
    const legoResult = await run(actionAgent, `Execute write_lego_concept with theme="${theme}"`);
    console.log('🧱 LEGO Concept Result:');
    console.log(legoResult.finalOutput);
    generatedContent.push(legoResult.finalOutput || '');
  }
  
  // Step 4: Final synthesis
  console.log('\n🎉 ORCHESTRATION AGENT - Final Delivery');
  const finalResponse = await run(orchestrationAgent, 
    `Provide a final response to the user for request: "${userRequest}". The Action Agent generated: ${generatedContent.join(' | ')}`
  );
  
  console.log('🏁 Final Response:');
  console.log(finalResponse.finalOutput);
  
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
🎨 Welcome to Orchestrator/Action Agent Demo!

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