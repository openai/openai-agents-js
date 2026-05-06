export type SandboxUser = {
  name: string;
};

export type SandboxUserInit = string | SandboxUser;

export type SandboxGroup = {
  name: string;
  users?: SandboxUser[];
};

export type SandboxGroupInit = {
  name: string;
  users?: SandboxUserInit[];
};

export type SandboxEntryGroup = SandboxUser | SandboxGroup;

export function normalizeUser(user: SandboxUserInit): SandboxUser {
  const name = (typeof user === 'string' ? user : user.name).trim();
  if (!name) {
    throw new Error('Sandbox user name must be non-empty.');
  }
  return { name };
}

export function normalizeGroup(group: SandboxGroupInit): SandboxGroup {
  const name = group.name.trim();
  if (!name) {
    throw new Error('Sandbox group name must be non-empty.');
  }
  return {
    name,
    ...(group.users
      ? { users: group.users.map((user) => normalizeUser(user)) }
      : {}),
  };
}

export function normalizeEntryGroup(
  group: SandboxEntryGroup,
): SandboxEntryGroup {
  if ('users' in group) {
    return normalizeGroup(group);
  }
  return normalizeUser(group);
}
