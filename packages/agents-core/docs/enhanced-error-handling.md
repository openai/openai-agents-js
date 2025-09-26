# Enhanced Error Handling

The OpenAI Agents SDK now includes enhanced error handling capabilities that provide detailed context, debugging information, and recovery suggestions when errors occur.

## Features

### Enhanced Error Context

All errors now include detailed context about the agent state when the error occurred:

```typescript
interface EnhancedErrorContext {
  agentName: string; // Name of the active agent
  turnNumber: number; // Current conversation turn
  lastSuccessfulOperation: string; // Last successful operation
  operationStack: string[]; // Stack of operations leading to error
  timestamp: Date; // When the error occurred
  runStateSnapshot?: {
    // Sanitized run state information
    maxTurns: number;
    generatedItemsCount: number;
    modelResponsesCount: number;
    toolUseTrackerSummary: Record<string, string[]>;
  };
}
```

### Recovery Suggestions

Errors automatically include contextual recovery suggestions:

```typescript
interface RecoveryAction {
  type: 'retry' | 'fallback' | 'skip' | 'restart' | 'manual';
  description: string;
  execute?: () => Promise<void>; // Optional automatic recovery
}
```

### Enhanced Error Classes

All error classes have been enhanced with context and suggestions:

- `SystemError` - System-level errors with troubleshooting guidance
- `UserError` - Configuration errors with fix suggestions
- `MaxTurnsExceededError` - Turn limit errors with optimization suggestions
- `ModelBehaviorError` - Model behavior issues with retry suggestions
- `ToolCallError` - Tool execution errors with tool-specific context
- `GuardrailExecutionError` - Guardrail failures with configuration guidance

## Usage Examples

### Creating Errors with Context

```typescript
import { createErrorContext, ToolCallError } from '@openai/agents';

// Create error context for operation tracking
const context = createErrorContext('tool_execution', state, {
  toolName: 'my-tool',
  toolArguments: { param: 'value' },
});

throw new ToolCallError('Tool execution failed', originalError, state, context);
```

### Using the AgentDebugger

```typescript
import { AgentDebugger } from '@openai/agents';

try {
  // Agent operation that might fail
  await run(agent, input);
} catch (error) {
  if (error instanceof AgentsError) {
    // Generate detailed debug report
    console.log(AgentDebugger.createDebugReport(error));

    // Get structured debug info
    console.log(error.getDebugInfo());

    // Extract state information
    const stateInfo = AgentDebugger.extractStateInfo(error.state);

    // Validate run state consistency
    const issues = AgentDebugger.validateRunState(error.state);
  }
}
```

### Operation Tracking

```typescript
import { createErrorContext, addOperationToContext } from '@openai/agents';

// Start with initial context
let context = createErrorContext('initialization');

// Add operations as they complete
context = addOperationToContext(context, 'validation');
context = addOperationToContext(context, 'processing');

// Use context when throwing errors
throw new SystemError('Processing failed', state, context);
```

## Debugging Utilities

### AgentDebugger.createDebugReport()

Generates a comprehensive debug report including:

- Error details and type
- Agent context and state
- Operation stack trace
- Recovery suggestions
- Stack trace

### AgentDebugger.extractStateInfo()

Extracts key debugging information from RunState:

- Agent name and turn information
- Generated items and model responses
- Tool usage tracking
- Guardrail results

### AgentDebugger.sanitizeStateForLogging()

Creates a sanitized version of state information safe for logging:

- Removes sensitive data
- Includes summary information
- Safe for production logging

### AgentDebugger.validateRunState()

Validates RunState consistency and returns any issues:

- Checks for invalid turn numbers
- Validates agent state
- Identifies inconsistencies

## Error Message Enhancement

Error messages are automatically enhanced with context:

```
Original: "Tool execution failed"
Enhanced: "Tool execution failed [Agent: my-agent, Turn: 3, Last operation: tool_execution]"
```

## Best Practices

1. **Use createErrorContext()** when throwing custom errors to provide operation context
2. **Add operation tracking** for complex workflows using addOperationToContext()
3. **Use AgentDebugger** in error handlers for comprehensive debugging information
4. **Check error.suggestions** for automated recovery options
5. **Sanitize state information** before logging in production environments

## Migration Guide

Existing error handling code will continue to work unchanged. To take advantage of enhanced features:

1. Update error constructors to include context:

   ```typescript
   // Before
   throw new ToolCallError('Failed', error, state);

   // After
   throw new ToolCallError(
     'Failed',
     error,
     state,
     createErrorContext('tool_execution', state, { toolName: 'my-tool' }),
   );
   ```

2. Use AgentDebugger in error handlers:

   ```typescript
   catch (error) {
     if (error instanceof AgentsError) {
       console.log(AgentDebugger.createDebugReport(error));
     }
   }
   ```

3. Check for recovery suggestions:
   ```typescript
   catch (error) {
     if (error instanceof AgentsError && error.suggestions.length > 0) {
       console.log('Recovery suggestions:', error.suggestions);
     }
   }
   ```
