# TODO Orchestration Pattern

## Objective

Create a **2-agent system** where an **Orchestration Agent** manages workflow coordination and state, while an **Action Agent** executes individual tools. The orchestrator maintains TODO lists, gathers missing inputs, and coordinates multi-step workflows. The action agent receives specific tools from the orchestrator and executes them.

## Core Architecture

### **🧠 Orchestration Agent** (Brain)
- **Workflow Coordination**: Manages TODO lists with completed/pending/current tasks
- **Input Validation**: Detects missing inputs and gathers them from user
- **Tool Discovery**: Calls `toolSelector` to identify relevant tools from user request
- **State Management**: Maintains conversation history across iterations
- **Completion Detection**: Determines when workflow is finished

### **⚡ Action Agent** (Hands)  
- **Tool Execution**: Receives specific tools from orchestrator and executes them
- **Single Focus**: Uses exactly one tool per request with `toolChoice: 'required'`
- **No Decision Making**: Simply executes what orchestrator assigns
- **Result Reporting**: Returns generated content to orchestrator

### **🔍 Tool Selector** (Intelligence)
- **Smart Tool Discovery**: Analyzes user requests to identify relevant tools from large catalogs
- **Scalable Architecture**: Designed to handle 1000s of available tools efficiently
- **Semantic Matching**: Uses LLM reasoning to match user intent with appropriate tools
- **Clean Separation**: Isolated tool selection logic for maintainability and testing
- **Extensible Design**: Can be enhanced with embeddings, tool categorization, or ML ranking

#### **Tool Selector Interface**
```javascript
const toolSelector = tool({
  name: 'toolSelector',
  description: 'Analyzes user requests to identify relevant tools',
  parameters: z.object({
    userRequest: z.string().describe('The user\'s request'),
    availableTools: z.array(z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.object({})
    })).describe('Array of all available tools')
  }),
  async execute({ userRequest, availableTools }) {
    // LLM analyzes request against tool catalog
    // Returns ranked list of relevant tools with reasoning
    return {
      selectedTools: ['write_poem', 'format_response'],
      reasoning: 'User wants creative content (poem) and formatting',
      confidence: 0.95,
      alternatives: ['write_blog_title', 'write_audio_jingle']
    };
  }
});
```

#### **Why Tool Selector?**

**🎯 Scalability**: Hard-coding tool lists in prompts becomes unwieldy with 100+ tools
- Orchestrator prompt stays clean and focused on workflow management
- Tool selection logic is centralized and testable
- Easy to add/remove tools without modifying orchestrator

**🧠 Intelligence**: LLM-powered tool matching vs simple keyword matching
- Understands user intent semantically ("create content" → multiple content tools)
- Handles ambiguous requests ("make something creative" → suggests multiple options)
- Can rank tools by relevance and suggest alternatives

**🔧 Maintainability**: Separation of concerns for complex tool ecosystems
- Tool selection logic separate from workflow orchestration
- Different teams can work on tool discovery vs workflow management
- Easy to A/B test different tool selection strategies

## How It Works

### **1. User Interaction**
```
User: "Write a poem about winter and format it"
```

### **2. Tool Discovery**
- **Call toolSelector**: Send user request to intelligent tool selection
- **Receive Tool Recommendations**: Get array of relevant tools with reasoning
- **Tool Validation**: Verify recommended tools are available and appropriate

### **3. Orchestration Analysis**
- **Parse Request**: Analyze user intent with selected tools
- **Input Validation**: Check if all required inputs provided for selected tools
- **Missing Input Gathering**: Prompt user for missing theme, parameters
- **TODO List Creation**: Queue tasks in execution order with dependency analysis

### **4. Iterative Execution Loop**
```
ITERATION 1:
📋 TODO: [write_poem (pending), format_response (pending)]
🎯 CURRENT: write_poem
⚡ ACTION: Execute write_poem with theme="winter"
✅ RESULT: Generated poem
📋 TODO: [write_poem (completed), format_response (pending)]

ITERATION 2: 
🎯 CURRENT: format_response
⚡ ACTION: Execute format_response with content=<poem>
✅ RESULT: Formatted poem
📋 TODO: [write_poem (completed), format_response (completed)]
🏁 COMPLETE: All tasks finished
```

### **5. Tool Assignment Pattern**
```javascript
// Step 1: Orchestrator discovers relevant tools
const toolSelection = await orchestrator.useTool('toolSelector', {
  userRequest: "write a poem about winter and format it",
  availableTools: [...ALL_TOOLS]
});
// Returns: ["write_poem", "format_response"]

// Step 2: Orchestrator plans workflow with selected tools
orchestrator: "Action agent needs to use write_poem with theme='winter'"

// Step 3: Orchestrator assigns tool to action agent
actionAgent.tools = [writePoemTool];

// Step 4: Action agent executes exactly one tool
actionAgent.run("Use write_poem with theme='winter'");
```

## Key Features

### **📋 Sophisticated Orchestration**
- **TODO List Management**: Tracks completed vs pending tasks
- **Conversation State**: Persistent across multiple iterations  
- **Input Gathering**: Asks user for missing parameters
- **Multi-Tool Workflows**: Coordinates complex sequences

### **🎭 Clean Agent Separation**
- **Orchestrator**: Plans, coordinates, never executes tools
- **Action Agent**: Executes tools, never makes decisions
- **Dynamic Tool Assignment**: Tools passed from orchestrator to action agent

### **🤝 Human Control (Optional)**
- **Approval Toggle**: `APPROVAL_ENABLED=true` for human-in-the-loop
- **Tool Approval**: Review each tool execution before it runs
- **State Persistence**: Save/restore during approval process

## Usage

### **🚀 Quick Start**
```bash
# Auto execution (no approvals)
npm run start:todo-orchestration-v5:auto

# With human approvals  
npm run start:todo-orchestration-v5:approval
```

### **🛠️ Available Tools**
- `write_poem` - Create poetry (needs: theme)
- `write_blog_title` - Generate blog titles (needs: theme)
- `write_audio_jingle` - Create jingles (needs: word_count, theme)
- `write_lego_concept` - Design LEGO sets (needs: theme)
- `format_response` - Format content in markdown (needs: content)

### **🎯 Example Workflows**
- **Single Tool**: "Create a LEGO set about space"
- **Multi-Tool**: "Write a poem about nature and format it" 
- **Missing Inputs**: "Write a jingle" → prompts for word count and theme

## Benefits

✅ **Scalable**: Handles simple single-tool to complex multi-tool workflows from 1000s of available tools  
✅ **Intelligent**: LLM-powered tool discovery understands user intent semantically  
✅ **Robust**: Input validation, error handling, state management  
✅ **Controlled**: Optional human approval for sensitive operations  
✅ **Modular**: Clean separation between tool discovery, planning, and execution  
✅ **Maintainable**: Easy to add new tools, modify workflows, or enhance tool selection logic  
✅ **Testable**: Tool selection logic isolated and independently verifiable
