import { UserError } from '../../../errors';
import type { MaterializeEntryArgs } from '../../session';

type CreateFile = (args: MaterializeEntryArgs) => Promise<void>;
const creators = new WeakMap<object, CreateFile>();

/** Register the resource owner's exclusive file creator. */
export function registerExclusiveWorkspaceCreate(
  session: object,
  create: CreateFile,
): CreateFile | undefined {
  const previous = creators.get(session);
  creators.set(session, create);
  return previous;
}

/** Check whether the resource supports exclusive file creation. */
export function hasExclusiveWorkspaceCreate(session: object): boolean {
  return creators.has(session);
}

/** Create a file without replacing a current workspace entry. */
export function createWorkspaceFileNoFollow(
  session: object,
  args: MaterializeEntryArgs,
): Promise<void> {
  const create = creators.get(session);
  if (!create)
    throw new UserError('Sandbox has no exclusive no-follow workspace creator');
  return create(args);
}
