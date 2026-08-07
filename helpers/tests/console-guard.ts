import { beforeEach, expect } from 'vitest';
import { installStdioGuard } from './stdioGuard';

function install(): void {
  installStdioGuard({
    scope: () =>
      `test: ${expect.getState().currentTestName ?? '<unknown test>'}`,
  });
}

install();

beforeEach(() => {
  // Reapply patches in case a previous test restored mocked console methods.
  install();
});
