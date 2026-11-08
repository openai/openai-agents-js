import {
  boundedFileReadCommand,
  decodeBoundedFileRead,
} from '@openai/agents-core/sandbox/internal';
import { UserError } from '@openai/agents-core';
import {
  SandboxProviderError,
  SandboxWorkspaceReadNotFoundError,
  type Entry,
} from '@openai/agents-core/sandbox';
import { RemoteSandboxEditor } from './editor';
import type { ManifestMaterializationOptions } from './manifest';
import { sandboxEntryPermissionsMode } from './metadata';
import {
  probeRemoteSandboxDirectoryExists,
  probeRemoteSandboxPathExists,
} from './pathProbe';
import { shellQuote } from './paths';
import type {
  RemoteManifestWriter,
  RemoteSandboxPathResolver,
  SandboxManifestMetadataSupport,
} from './types';

export type RemoteRunAsCommandResult = {
  status: number;
  stdout?: string;
  stderr?: string;
};

export type RemoteRunAsCommandRunner = (
  command: string,
  options?: { runAs?: string },
) => Promise<RemoteRunAsCommandResult>;

export function sandboxUserShellCommand(
  command: string,
  user?: string,
): string {
  if (!user) {
    return command;
  }
  return [
    `target_user=${shellQuote(user)}`,
    'current_uid="$(id -u)"',
    'current_user="$(id -un 2>/dev/null || id -u)"',
    'if [ "$current_uid" = "$target_user" ] || [ "$current_user" = "$target_user" ]; then',
    `  sh -lc ${shellQuote(command)}`,
    'elif [ "$current_uid" -eq 0 ]; then',
    `  su -s /bin/sh "$target_user" -c ${shellQuote(command)}`,
    'else',
    `  sudo -n -u "$target_user" -- sh -lc ${shellQuote(command)}`,
    'fi',
  ].join('\n');
}

export function createRunAsRemoteEditor(args: {
  providerName: string;
  providerId: string;
  runAs: string;
  resolvePath: RemoteSandboxPathResolver;
  runCommand: RemoteRunAsCommandRunner;
  writer: RemoteManifestWriter;
  beforeFilesystemMutation?: () => Promise<void>;
}): RemoteSandboxEditor {
  return new RemoteSandboxEditor({
    resolvePath: args.resolvePath,
    mkdir: async (path) => {
      await args.beforeFilesystemMutation?.();
      await runCheckedRunAsRemoteCommand(
        args.providerName,
        args.providerId,
        args.runCommand,
        `mkdir -p -- ${shellQuote(path)}`,
        `create directory ${path}`,
        args.runAs,
      );
    },
    readText: async (path) =>
      new TextDecoder().decode(
        await readRunAsRemoteFile({
          providerName: args.providerName,
          providerId: args.providerId,
          path,
          runAs: args.runAs,
          runCommand: args.runCommand,
        }),
      ),
    pathExists: async (path) =>
      await runAsRemotePathExists(path, args.runAs, args.runCommand, {
        providerName: args.providerName,
        providerId: args.providerId,
      }),
    writeText: async (path, content) => {
      await args.beforeFilesystemMutation?.();
      await writeRunAsRemoteText({
        providerName: args.providerName,
        providerId: args.providerId,
        path,
        content,
        runAs: args.runAs,
        runCommand: args.runCommand,
        writer: args.writer,
      });
    },
    deletePath: async (path) => {
      await args.beforeFilesystemMutation?.();
      await runCheckedRunAsRemoteCommand(
        args.providerName,
        args.providerId,
        args.runCommand,
        `rm -f -- ${shellQuote(path)}`,
        `delete path ${path}`,
        args.runAs,
      );
    },
  });
}

export async function readRunAsRemoteFile(args: {
  providerName: string;
  providerId: string;
  path: string;
  runAs?: string;
  maxBytes?: number;
  runCommand: RemoteRunAsCommandRunner;
}): Promise<Uint8Array> {
  if (
    args.maxBytes !== undefined &&
    (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 0)
  ) {
    throw new UserError('maxBytes must be a non-negative safe integer.');
  }
  const command =
    args.maxBytes === undefined
      ? `base64 -- ${shellQuote(args.path)}`
      : `PATH=/usr/bin:/bin; test -f ${shellQuote(args.path)} && exec 3< ${shellQuote(args.path)} && ${boundedFileReadCommand(args.maxBytes)}`;
  const output = await runCheckedRunAsRemoteCommand(
    args.providerName,
    args.providerId,
    args.runCommand,
    command,
    `read file ${args.path}`,
    args.runAs,
    args.maxBytes === undefined ? undefined : args.path,
  );
  const bytes = decodeBase64(output);
  return args.maxBytes === undefined
    ? bytes
    : decodeBoundedFileRead(
        bytes,
        new SandboxProviderError(
          `${args.providerName} failed to read file ${args.path}`,
          { provider: args.providerId },
        ),
      );
}

export async function runAsRemotePathExists(
  path: string,
  runAs: string | undefined,
  runCommand: RemoteRunAsCommandRunner,
  provider: {
    providerName: string;
    providerId: string;
  } = {
    providerName: 'RemoteSandboxClient',
    providerId: 'remote',
  },
): Promise<boolean> {
  return await probeRemoteSandboxPathExists({
    ...provider,
    path,
    runCommand: async (command) => await runCommand(command, { runAs }),
  });
}

export async function runAsRemoteDirectoryExists(
  path: string,
  runAs: string | undefined,
  runCommand: RemoteRunAsCommandRunner,
  provider: {
    providerName: string;
    providerId: string;
  } = {
    providerName: 'RemoteSandboxClient',
    providerId: 'remote',
  },
): Promise<boolean> {
  return await probeRemoteSandboxDirectoryExists({
    ...provider,
    path,
    runCommand: async (command) => await runCommand(command, { runAs }),
  });
}

export async function writeRunAsRemoteText(args: {
  providerName: string;
  providerId: string;
  path: string;
  content: string;
  runAs: string;
  runCommand: RemoteRunAsCommandRunner;
  writer: RemoteManifestWriter;
}): Promise<void> {
  const tempDir = `/tmp/openai-agents-${randomId()}`;
  const uploadDir = `${tempDir}/upload`;
  const tempPath = `${uploadDir}/content`;
  // Keep the outer directory private even if the provider prepares the upload
  // parent or writes additional temporary files with broader permissions.
  await runCheckedRunAsRemoteCommand(
    args.providerName,
    args.providerId,
    args.runCommand,
    `umask 077 && mkdir -- ${shellQuote(tempDir)}`,
    `create temporary directory ${tempDir}`,
  );
  try {
    await args.writer.mkdir(uploadDir);
    await args.writer.writeFile(tempPath, args.content);
    await runCheckedRunAsRemoteCommand(
      args.providerName,
      args.providerId,
      args.runCommand,
      [
        `chmod 0600 -- ${shellQuote(tempPath)}`,
        `chmod 0711 -- ${shellQuote(uploadDir)}`,
        `chown ${shellQuote(args.runAs)}:${shellQuote(args.runAs)} -- ${shellQuote(tempPath)} ${shellQuote(tempDir)}`,
      ].join(' && '),
      `prepare temporary file ${tempPath}`,
      'root',
    );
    await runCheckedRunAsRemoteCommand(
      args.providerName,
      args.providerId,
      args.runCommand,
      `cat -- ${shellQuote(tempPath)} > ${shellQuote(args.path)}`,
      `write file ${args.path}`,
      args.runAs,
    );
  } finally {
    await args
      .runCommand(`rm -rf -- ${shellQuote(tempDir)}`, { runAs: 'root' })
      .catch(() => {});
  }
}

export function manifestMaterializationOptionsWithRunAs(args: {
  providerName: string;
  providerId: string;
  runAs?: string;
  runCommand: RemoteRunAsCommandRunner;
  options?: ManifestMaterializationOptions;
  support?: SandboxManifestMetadataSupport;
}): ManifestMaterializationOptions {
  const options = args.options ?? {};
  if (
    !args.runAs &&
    !args.support?.entryGroups &&
    !args.support?.entryPermissions
  ) {
    return options;
  }
  return {
    ...options,
    applyMetadata: async (absolutePath, entry) => {
      await options.applyMetadata?.(absolutePath, entry);
      await applyRunAsManifestEntryMetadata({
        providerName: args.providerName,
        providerId: args.providerId,
        absolutePath,
        entry,
        runAs: args.runAs,
        runCommand: args.runCommand,
        support: args.support,
      });
    },
  };
}

async function applyRunAsManifestEntryMetadata(args: {
  providerName: string;
  providerId: string;
  absolutePath: string;
  entry: Entry;
  runAs?: string;
  runCommand: RemoteRunAsCommandRunner;
  support?: SandboxManifestMetadataSupport;
}): Promise<void> {
  const commands: string[] = [];
  if (args.runAs) {
    commands.push(
      `chown ${shellQuote(args.runAs)}:${shellQuote(args.runAs)} -- ${shellQuote(args.absolutePath)}`,
    );
  }
  if (args.support?.entryGroups && args.entry.group) {
    commands.push(
      `chgrp ${shellQuote(args.entry.group.name)} -- ${shellQuote(args.absolutePath)}`,
    );
  }
  if (args.support?.entryPermissions) {
    commands.push(
      `chmod ${sandboxEntryPermissionsMode(args.entry)} -- ${shellQuote(args.absolutePath)}`,
    );
  }
  if (commands.length === 0) {
    return;
  }
  await runCheckedRunAsRemoteCommand(
    args.providerName,
    args.providerId,
    args.runCommand,
    commands.join(' && '),
    `apply metadata to ${args.absolutePath}`,
    'root',
  );
}

async function runCheckedRunAsRemoteCommand(
  providerName: string,
  providerId: string,
  runCommand: RemoteRunAsCommandRunner,
  command: string,
  action: string,
  runAs?: string,
  missingFilePath?: string,
): Promise<string> {
  const result = await runCommand(command, { runAs });
  if (
    missingFilePath !== undefined &&
    result.status !== 0 &&
    !(await probeRemoteSandboxPathExists({
      providerName,
      providerId,
      path: missingFilePath,
      runCommand: async (command) => await runCommand(command, { runAs }),
    }))
  ) {
    throw new SandboxWorkspaceReadNotFoundError(
      `${providerName} sandbox file not found: ${missingFilePath}`,
      { provider: providerId, path: missingFilePath },
    );
  }
  if (result.status !== 0) {
    const output = [result.stdout ?? '', result.stderr ?? '']
      .filter((value) => value.trim().length > 0)
      .join('\n');
    throw new SandboxProviderError(
      `${providerName} failed to ${action}${output ? `: ${output}` : ''}`,
      {
        provider: providerId,
      },
    );
  }
  return result.stdout ?? '';
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/gu, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(16).slice(2)
  ).replace(/-/gu, '');
}
