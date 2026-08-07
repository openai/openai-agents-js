const MAX_TEST_WORKERS = 8;

export function recommendedTestWorkers(availableWorkers: number): number {
  return Math.max(1, Math.min(MAX_TEST_WORKERS, availableWorkers - 1));
}
