import {
  Environment,
  allowExecutorCall,
  replaceExecutorArguments,
  stopExecutorTurn,
} from '@openai/agents';

type Context = {
  allow: boolean;
  stop: boolean;
};

/** Configure the executor callbacks; the caller owns Session and executor lifecycle. */
export function executorEnvironment(url: string, cwd: string) {
  return new Environment<Context>({
    url,
    cwd,
    tools: ['exec_command', 'write_stdin', 'apply_patch'],
    approval({ context }) {
      if (context.stop) return stopExecutorTurn('Application policy');
      return context.allow;
    },
    transformArguments({ toolName }) {
      if (toolName === 'exec_command') {
        return replaceExecutorArguments({ cmd: 'printf approved' });
      }
      return allowExecutorCall();
    },
    // Result JSON remains data, including an action field.
    transformResult(_context, result) {
      return { action: 'stop', result };
    },
  });
}
