# TODO Orchestration Pattern

## Objective

Create a two-agent system where an **Orchestration Agent** manages high-level task coordination and state, while an **Action Agent** executes individual tools. The orchestration agent maintains a to-do list, decides when to continue looping, and delivers final answers. The action agent focuses solely on executing one tool at a time.

## Implementation Approach

### Configuration

- **Approval Toggle**
  - Boolean flag to enable/disable human-in-the-loop approval
  - When enabled, all action agent tool calls require user confirmation
  - When disabled, tools execute automatically without interruption
  - Can be set globally or per-tool basis

### Orchestration Agent Responsibilities

- **User Interaction & Discovery**
  - Start by presenting available tool options to the user
  - Summarize capabilities: "What do you want to do today? Here are some options..."
  - Guide user through tool selection and input gathering process

- **Input Requirements Management**
  - Analyze selected tools and identify all required inputs
  - Check if user's request contains all necessary parameters
  - If inputs are missing, continue asking user until all are gathered
  - Validate input completeness before proceeding to execution

- **Tool Selection & Chaining**
  - Select appropriate tools based on user intent
  - Support multi-tool workflows (e.g., "write poem and format it")
  - Pass focused tool sets with complete inputs to action agent
  - Coordinate sequential tool execution for complex requests

- **To-Do List Management**
  - Maintain current task state and progress
  - Track completed and pending items
  - Update task list based on action agent results
  - Use conversation history to persist state across iterations

- **Loop Decision Logic**
  - Evaluate completion criteria after each action agent execution
  - Decide whether to continue with more tasks or terminate
  - Handle missing input scenarios by continuing conversation
  - Implement maximum iteration limits for safety

- **Final Answer Delivery**
  - Synthesize results from multiple action agent executions
  - Provide comprehensive final response
  - Include summary of completed tasks

### Action Agent Responsibilities

- **Single Tool Execution**
  - Use `stop_on_first_tool` behavior to ensure exactly one tool call
  - Set `toolChoice: 'required'` to force tool usage
  - Return immediately after tool execution
  - No decision making or orchestration logic

- **Optional Human Approval**
  - Support toggle for human-in-the-loop tool approval
  - When approval toggle is enabled, request user confirmation before tool execution
  - Handle approval/rejection workflow from `human-in-the-loop.ts` pattern
  - Allow user to approve or reject individual tool calls

### Pattern Integration

- **State Management** (from `llm-as-a-judge.ts`)
  - Use `inputItems` array to maintain conversation state
  - Track progress across multiple iterations
  - Persist to-do list state in conversation history

- **Decision Gates** (from `deterministic.ts`)
  - Clear boolean logic for continuation decisions
  - Quality checks between iterations
  - Early termination conditions

- **Controlled Tool Use** (from `forcing-tool-use.ts`)
  - Enforce single tool execution in action agent
  - Prevent action agent from making multiple calls
  - Ensure predictable execution flow

- **Human Approval** (from `human-in-the-loop.ts`)
  - Optional approval toggle for tool execution
  - Use `needsApproval` function on tools when toggle is enabled
  - Handle interruptions and approval/rejection workflow
  - State persistence during approval process

### Workflow

1. **Discovery & Planning**
   - Orchestration agent presents available tools to user
   - User selects desired action(s) from available options
   - Orchestration agent analyzes request and identifies required tools
   - Creates initial to-do list with input requirements

2. **Input Gathering Loop**
   - Check if all required inputs are available for selected tools
   - If inputs missing: ask user for specific missing parameters
   - Continue input gathering until all tool requirements satisfied
   - Validate input completeness before proceeding to execution

3. **Execution Loop**
   - Orchestration agent selects next task from to-do list
   - Passes focused tool set WITH complete inputs to action agent
   - **Optional Approval Step** (if toggle enabled):
     - Action agent requests tool execution
     - System interrupts and prompts user for approval
     - User approves or rejects the tool call
     - If rejected, orchestration agent adjusts plan
   - Action agent executes single tool and returns result
   - For multi-tool tasks: continue with next tool in sequence
   - Orchestration agent updates to-do list based on results
   - Evaluates if more work is needed

4. **Completion**
   - Orchestration agent determines all tasks complete
   - Synthesizes final answer from all executions
   - Delivers comprehensive response to user

### Example Tools

- **`write_poem`** - Creates poetry based on a given theme
  - Required input: `theme` (string)
  - Example: theme="nature" → generates nature-themed poem

- **`write_blog_title`** - Generates compelling blog post titles
  - Required input: `theme` (string) 
  - Example: theme="productivity" → "10 Proven Strategies to Boost Your Daily Productivity"

- **`write_audio_jingle`** - Creates short promotional jingles
  - Required input: `word_count` (number)
  - Example: word_count=8 → "Fresh coffee brewed just right for you!"

- **`write_lego_concept`** - Designs new LEGO kit concepts
  - Required input: `theme` (string)
  - Example: theme="space exploration" → detailed Mars rover LEGO set concept

- **`format_response`** - Formats creative writing in markdown
  - Required input: `content` (string)
  - Example: converts plain text to properly formatted markdown

### Multi-Tool Workflows

- **"Write a poem about winter and format it"**
  - Tools: `write_poem` → `format_response`
  - Inputs: theme="winter", then content=<poem_output>

- **"Create a blog title and jingle for my coffee shop"**
  - Tools: `write_blog_title` + `write_audio_jingle`
  - Inputs: theme="coffee shop", word_count=10

### Key Benefits

- **Clear Separation of Concerns**: Orchestration vs. execution
- **Input Validation**: Ensures all required parameters are gathered
- **Tool Chaining**: Supports multi-step creative workflows  
- **Predictable Tool Usage**: Always one tool per action agent call
- **State Persistence**: To-do list maintained across iterations
- **Controlled Flow**: Clear decision points for continuation
- **User Control**: Optional human approval for sensitive tool executions
- **Scalable**: Can handle complex multi-step tasks
