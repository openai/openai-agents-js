import type { AgentToolInvocationInfo } from './agentToolInvocationInfo';

export function attachAgentToolInvocation<TResult extends object>(
  result: TResult,
  metadata: AgentToolInvocationInfo,
): TResult & { agentToolInvocation: AgentToolInvocationInfo } {
  try {
    Object.defineProperty(result, 'agentToolInvocation', {
      value: metadata,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    return result as TResult & { agentToolInvocation: AgentToolInvocationInfo };
  } catch {
    return new Proxy(result, {
      get(target, prop, receiver) {
        if (prop === 'agentToolInvocation') {
          return metadata;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TResult & { agentToolInvocation: AgentToolInvocationInfo };
  }
}
