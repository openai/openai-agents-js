import { setTracingDisabled } from '../../packages/agents-core/src/tracing';

export function setupTests(): void {
  setTracingDisabled(true);
}
