# TODO Orchestration Pattern

## Objective

Create a **2-agent system** where an **Orchestration Agent** manages workflow coordination and state, while an **Action Agent** executes individual tools. The orchestrator maintains TODO lists, gathers missing inputs, and coordinates multi-step workflows. The action agent receives specific tools from the orchestrator and executes them.

## Core Architecture

### **🧠 Orchestration Agent** (Brain)
- **Workflow Coordination**: Manages TODO lists with completed/pending/current tasks
- **Input Validation**: Detects missing inputs and gathers them from user
- **Tool Selection**: Chooses appropriate tools and passes them to action agent
- **State Management**: Maintains conversation history across iterations
- **Completion Detection**: Determines when workflow is finished

### **⚡ Action Agent** (Hands)  
- **Tool Execution**: Receives specific tools from orchestrator and executes them
- **Single Focus**: Uses exactly one tool per request with `toolChoice: 'required'`
- **No Decision Making**: Simply executes what orchestrator assigns
- **Result Reporting**: Returns generated content to orchestrator

## How It Works

### **1. User Interaction**
```
User: "Write a poem about winter and format it"
```

### **2. Orchestration Analysis**
- **Parse Request**: Identify needed tools (`write_poem`, `format_response`)
- **Input Validation**: Check if all required inputs provided
- **Missing Input Gathering**: Prompt user for missing theme, parameters
- **TODO List Creation**: Queue tasks in execution order

### **3. Iterative Execution Loop**
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

### **4. Tool Assignment Pattern**
```javascript
// Orchestrator decides what to do
orchestrator: "Action agent needs to use write_poem with theme='winter'"

// Orchestrator assigns tool to action agent
actionAgent.tools = [writePoemTool];

// Action agent executes exactly one tool
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

✅ **Scalable**: Handles simple single-tool to complex multi-tool workflows  
✅ **Robust**: Input validation, error handling, state management  
✅ **Controlled**: Optional human approval for sensitive operations  
✅ **Clear**: Clean separation between planning and execution  
✅ **Maintainable**: Easy to add new tools or modify workflows
