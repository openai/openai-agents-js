/** Native owned-restore cleanup, after Git staging and before destination writes. */
export const beforeGitRepoCopy = Symbol('beforeGitRepoCopy');
export type BeforeGitRepoCopy = {
  limits: { maxMembers: number; maxDepth: number };
  prepare: (
    children: readonly string[],
    files: readonly string[],
  ) => Promise<void>;
};
