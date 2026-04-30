import {
  applyDiff,
  UserError,
  type ApplyPatchOperation,
  type ApplyPatchResult,
  type Editor,
} from '@openai/agents-core';
import { posixDirname } from './paths';
import type { RemoteEditorIo } from './types';

export class RemoteSandboxEditor implements Editor {
  private readonly io: RemoteEditorIo;

  constructor(io: RemoteEditorIo) {
    this.io = io;
  }

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
  ): Promise<ApplyPatchResult> {
    const path = await this.resolvePath(operation.path, { forWrite: true });
    if (await this.pathExists(path)) {
      throw new UserError(
        `Cannot create file because it already exists: ${path}`,
      );
    }
    const content = applyDiff('', operation.diff, 'create');
    const parent = posixDirname(path);
    if (this.io.mkdir && parent !== '.' && parent !== '/') {
      await this.io.mkdir(parent);
    }
    await this.io.writeText(path, content);
    return {};
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
  ): Promise<ApplyPatchResult> {
    const moveTo = operation.moveTo;
    const path = await this.resolvePath(operation.path, { forWrite: true });
    const destination = moveTo
      ? await this.resolvePath(moveTo, { forWrite: true })
      : path;
    const current = await this.io.readText(path);
    const next = applyDiff(current, operation.diff);
    const parent = posixDirname(destination);
    if (this.io.mkdir && parent !== '.' && parent !== '/') {
      await this.io.mkdir(parent);
    }
    await this.io.writeText(destination, next);
    if (moveTo && destination !== path) {
      await this.io.deletePath(path);
    }
    return {};
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
  ): Promise<ApplyPatchResult> {
    await this.io.deletePath(
      await this.resolvePath(operation.path, { forWrite: true }),
    );
    return {};
  }

  private async resolvePath(
    path: string,
    options?: { forWrite?: boolean },
  ): Promise<string> {
    return this.io.resolvePath
      ? await this.io.resolvePath(path, options)
      : path;
  }

  private async pathExists(path: string): Promise<boolean> {
    if (this.io.pathExists) {
      return await this.io.pathExists(path);
    }
    try {
      await this.io.readText(path);
      return true;
    } catch {
      return false;
    }
  }
}
