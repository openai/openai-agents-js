import { UserError } from '../../../errors';
import type { MaterializeEntryArgs } from '../../session';

type CreateFile = (args: MaterializeEntryArgs) => Promise<void>;
const creators = new WeakMap<object, CreateFile>();

/** @internal The owning backend has been supplying its protected create-only primitive. */
export function registerExclusiveWorkspaceCreate(
  session: object,
  create: CreateFile,
): CreateFile | undefined {
  const previous = creators.get(session);
  creators.set(session, create);
  return previous;
}

/** @internal Unsupported backends have been rejecting live additions before IO. */
export function hasExclusiveWorkspaceCreate(session: object): boolean {
  return creators.has(session);
}

/** @internal Existing files have been retaining their identity at the write boundary. */
export function createWorkspaceFileNoFollow(
  session: object,
  args: MaterializeEntryArgs,
): Promise<void> {
  const create = creators.get(session);
  if (!create)
    throw new UserError('Sandbox has no exclusive no-follow workspace creator');
  return create(args);
}
