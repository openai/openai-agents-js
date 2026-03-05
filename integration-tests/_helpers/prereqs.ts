import { access, readFile, unlink, writeFile } from 'node:fs/promises';

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

export function requireEnvVar(name: string, consumer: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set to run ${consumer}.`);
  }
  return value;
}

export async function withManagedFile(
  filePath: string,
  contents: string,
): Promise<() => Promise<void>> {
  let previousContents: string | null = null;

  try {
    previousContents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await writeFile(filePath, contents, 'utf8');

  return async () => {
    if (previousContents === null) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
      }
      return;
    }

    await writeFile(filePath, previousContents, 'utf8');
  };
}

export async function assertPathExists(
  filePath: string,
  message: string,
): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(message);
  }
}
