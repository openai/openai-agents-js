// Configuration validation utilities for agents
export function validateConfig(config: any): boolean {
    const required = ['model', 'apiKey'];
    for (const key of required) {
        if (!config[key]) return false;
    }
    return true;
}

export function validateModelName(model: string): boolean {
    const validModels = [
        'gpt-4',
        'gpt-4-turbo',
        'gpt-3.5-turbo',
    ];
    return validModels.includes(model);
}

export interface AgentConfig {
    model: string;
    apiKey: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
}

export function createDefaultConfig(apiKey: string): AgentConfig {
    return {
        model: 'gpt-4',
        apiKey,
        temperature: 0.7,
        maxTokens: 2048,
        timeout: 30000,
    };
}
