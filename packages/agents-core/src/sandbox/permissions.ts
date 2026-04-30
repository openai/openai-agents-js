export enum FileMode {
  ALL = 0o7,
  NONE = 0,
  READ = 1 << 2,
  WRITE = 1 << 1,
  EXEC = 1,
}

export type PermissionsValue = {
  owner?: number;
  group?: number;
  other?: number;
  directory?: boolean;
};

export type PermissionsInit = PermissionsValue | string | number | Permissions;

export const DEFAULT_SANDBOX_ENTRY_PERMISSIONS: Required<PermissionsValue> = {
  owner: FileMode.ALL,
  group: FileMode.READ | FileMode.EXEC,
  other: FileMode.READ | FileMode.EXEC,
  directory: false,
};

export function permissionsForSandboxEntry(
  permissions?: PermissionsInit,
): Permissions {
  return new Permissions(permissions ?? DEFAULT_SANDBOX_ENTRY_PERMISSIONS);
}

export class Permissions {
  readonly owner: number;
  readonly group: number;
  readonly other: number;
  readonly directory: boolean;

  constructor(init: PermissionsInit = {}) {
    if (init instanceof Permissions) {
      this.owner = init.owner;
      this.group = init.group;
      this.other = init.other;
      this.directory = init.directory;
      return;
    }

    if (typeof init === 'string') {
      const parsed = Permissions.fromString(init);
      this.owner = parsed.owner;
      this.group = parsed.group;
      this.other = parsed.other;
      this.directory = parsed.directory;
      return;
    }

    if (typeof init === 'number') {
      const parsed = Permissions.fromMode(init);
      this.owner = parsed.owner;
      this.group = parsed.group;
      this.other = parsed.other;
      this.directory = parsed.directory;
      return;
    }

    this.owner = normalizePermissionBits(init.owner ?? FileMode.ALL, 'owner');
    this.group = normalizePermissionBits(init.group ?? FileMode.NONE, 'group');
    this.other = normalizePermissionBits(init.other ?? FileMode.NONE, 'other');
    this.directory = init.directory ?? false;
  }

  static fromMode(mode: number): Permissions {
    return new Permissions({
      owner: (mode >> 6) & 0b111,
      group: (mode >> 3) & 0b111,
      other: mode & 0b111,
      directory: (mode & 0o40000) !== 0,
    });
  }

  static fromString(value: string): Permissions {
    const permissions =
      value.length === 11 && /[@+]$/u.test(value) ? value.slice(0, -1) : value;
    if (permissions.length !== 10) {
      throw new Error(`Invalid permissions string length: ${value}`);
    }
    if (permissions[0] !== 'd' && permissions[0] !== '-') {
      throw new Error(`Invalid permissions type: ${value}`);
    }

    return new Permissions({
      directory: permissions[0] === 'd',
      owner: parsePermissionTriplet(permissions.slice(1, 4)),
      group: parsePermissionTriplet(permissions.slice(4, 7)),
      other: parsePermissionTriplet(permissions.slice(7, 10)),
    });
  }

  toMode(): number {
    return (
      (this.directory ? 0o40000 : 0) |
      (this.owner << 6) |
      (this.group << 3) |
      this.other
    );
  }

  normalized(): Required<PermissionsValue> {
    return {
      owner: this.owner,
      group: this.group,
      other: this.other,
      directory: this.directory,
    };
  }

  toString(): string {
    return `${this.directory ? 'd' : '-'}${formatPermissionTriplet(
      this.owner,
    )}${formatPermissionTriplet(this.group)}${formatPermissionTriplet(
      this.other,
    )}`;
  }
}

export function normalizePermissions(
  permissions: PermissionsInit,
): Required<PermissionsValue> {
  return new Permissions(permissions).normalized();
}

function normalizePermissionBits(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0b111) {
    throw new Error(`Permission ${label} bits must be an integer from 0 to 7.`);
  }
  return value;
}

function parsePermissionTriplet(value: string): number {
  if (value.length !== 3) {
    throw new Error(`Invalid permissions triplet: ${value}`);
  }

  let mode = 0;
  if (value[0] === 'r') {
    mode |= FileMode.READ;
  } else if (value[0] !== '-') {
    throw new Error(`Invalid read flag: ${value}`);
  }
  if (value[1] === 'w') {
    mode |= FileMode.WRITE;
  } else if (value[1] !== '-') {
    throw new Error(`Invalid write flag: ${value}`);
  }
  if (value[2] === 'x') {
    mode |= FileMode.EXEC;
  } else if (value[2] !== '-') {
    throw new Error(`Invalid exec flag: ${value}`);
  }
  return mode;
}

function formatPermissionTriplet(value: number): string {
  return [
    value & FileMode.READ ? 'r' : '-',
    value & FileMode.WRITE ? 'w' : '-',
    value & FileMode.EXEC ? 'x' : '-',
  ].join('');
}
