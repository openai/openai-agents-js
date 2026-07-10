// State management helpers for agents

export interface AgentState {
    id: string;
    status: 'idle' | 'running' | 'paused' | 'error' | 'completed';
    lastUpdated: Date;
    executionCount: number;
}

export function createAgentState(id: string): AgentState {
    return {
        id,
        status: 'idle',
        lastUpdated: new Date(),
        executionCount: 0,
    };
}

export function updateAgentStatus(
    state: AgentState,
    status: AgentState['status']
): AgentState {
    return {
        ...state,
        status,
        lastUpdated: new Date(),
    };
}

export function incrementExecutionCount(state: AgentState): AgentState {
    return {
        ...state,
        executionCount: state.executionCount + 1,
        lastUpdated: new Date(),
    };
}

export function isAgentRunning(state: AgentState): boolean {
    return state.status === 'running';
}

export function canAgentStart(state: AgentState): boolean {
    return state.status === 'idle' || state.status === 'paused';
}
