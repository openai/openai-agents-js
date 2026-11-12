/** Native owned-restore cleanup, after Git staging and before destination writes. */
export const beforeGitRepoCopy = Symbol('beforeGitRepoCopy');
export type BeforeGitRepoCopy = (children: readonly string[]) => Promise<void>;
