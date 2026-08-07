import { guardGlobalSetup } from './stdioGuard';

export function setup() {
  return guardGlobalSetup(async () => {
    const { setupTests } = await import('./setupTests');
    return setupTests();
  });
}
