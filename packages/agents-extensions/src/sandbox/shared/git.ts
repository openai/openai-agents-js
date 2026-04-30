import { UserError } from '@openai/agents-core';

export function normalizeGitRepository(
  repositoryOrEntry:
    | string
    | {
        host?: string;
        repo: string;
      },
): string {
  const repository =
    typeof repositoryOrEntry === 'string'
      ? repositoryOrEntry
      : repositoryOrEntry.repo;
  if (!repository) {
    throw new UserError('git_repo entries require a repo.');
  }
  if (repository.includes('://') || repository.startsWith('git@')) {
    return repository;
  }

  const host =
    typeof repositoryOrEntry === 'string'
      ? 'github.com'
      : (repositoryOrEntry.host ?? 'github.com');
  return `https://${host}/${repository}.git`;
}
