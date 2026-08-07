import { setTracingDisabled } from '../../packages/agents-core/src';

export function setupTests(): void {
  setTracingDisabled(true);
}
