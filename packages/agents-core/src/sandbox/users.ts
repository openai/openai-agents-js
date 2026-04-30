export type SandboxUser = {
  name: string;
};

export type SandboxGroup = {
  name: string;
  users?: SandboxUser[];
};

export type SandboxEntryGroup = SandboxUser | SandboxGroup;

export function normalizeUser(user: SandboxUser): SandboxUser {
  const name = user.name.trim();
  if (!name) {
    throw new Error('Sandbox user name must be non-empty.');
  }
  return { name };
}

export function normalizeGroup(group: SandboxGroup): SandboxGroup {
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
