import { z } from 'zod';
import type { ApplyPatchResult, Editor } from '../../editor';
import { UserError } from '../../errors';
import {
  applyPatchTool,
  tool,
  type FunctionTool,
  type Tool,
  type ToolOutputImage,
} from '../../tool';
import type {
  JsonObjectSchema,
  JsonSchemaDefinitionEntry,
} from '../../types/helpers';
import { ApplyPatchOperation } from '../../types/protocol';
import { encodeUint8ArrayToBase64 } from '../../utils/base64';
import type { ViewImageArgs } from '../session';
import { withSandboxSpan } from '../runtime/spans';
import { isRecord } from '../shared/typeGuards';
import {
  Capability,
  type ConfigureCapabilityTools,
  requireBoundSession,
} from './base';
import {
  supportsApplyPatchTransport,
  supportsStructuredToolOutputTransport,
} from './transport';

export type FilesystemArgs = {
  configureTools?: ConfigureCapabilityTools;
};

const applyPatchFunctionParameters: JsonObjectSchema<
  Record<string, JsonSchemaDefinitionEntry>
> = {
  type: 'object',
  properties: {
    patch: {
      type: 'string',
      description:
        'A freeform apply_patch payload wrapped in *** Begin Patch and *** End Patch.',
    },
    operation: {
      type: 'object',
      description: 'A single structured apply_patch operation.',
    },
    operations: {
      type: 'array',
      items: { type: 'object' },
      description: 'Structured apply_patch operations to apply in order.',
    },
    command: {
      type: 'array',
      description: 'Optional ["apply_patch", patch] command tuple form.',
    },
    type: {
      type: 'string',
      enum: ['create_file', 'update_file', 'delete_file'],
      description: 'The patch operation to apply.',
    },
    path: {
      type: 'string',
      description: 'The sandbox file path to patch.',
    },
    diff: {
      type: 'string',
      description:
        'The V4A patch diff for create_file and update_file operations.',
    },
    moveTo: {
      type: 'string',
      description: 'Optional destination path for update_file move operations.',
    },
  },
  required: [],
  additionalProperties: true,
};

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type ViewImageToolResult = ToolOutputImage | string;

function renderImageForTextTransport(output: ViewImageToolResult): string {
  if (typeof output === 'string') {
    return output;
  }

  const image = output.image;
  if (typeof image === 'string') {
    return image;
  }
  if (!isRecord(image)) {
    return 'No image data was returned by the sandbox session.';
  }
  const imageRecord = image as Record<string, unknown>;
  if (typeof imageRecord.url === 'string') {
    return imageRecord.url;
  }
  if (typeof imageRecord.fileId === 'string') {
    return `OpenAI file reference: ${imageRecord.fileId}`;
  }
  if (typeof imageRecord.data === 'string') {
    const mediaType =
      typeof imageRecord.mediaType === 'string'
        ? imageRecord.mediaType
        : 'application/octet-stream';
    return `data:${mediaType};base64,${imageRecord.data}`;
  }
  if (imageRecord.data instanceof Uint8Array) {
    const mediaType =
      typeof imageRecord.mediaType === 'string'
        ? imageRecord.mediaType
        : 'application/octet-stream';
    return `data:${mediaType};base64,${encodeUint8ArrayToBase64(imageRecord.data)}`;
  }

  return 'No image data was returned by the sandbox session.';
}

function renderViewImageError(path: string, error: unknown): string {
  const message = toErrorMessage(error);
  if (/not found/iu.test(message)) {
    return `image path \`${path}\` was not found`;
  }
  if (/not a file/iu.test(message)) {
    return `image path \`${path}\` is not a file`;
  }
  if (/exceeds the 10 MB limit|exceeded the allowed size/iu.test(message)) {
    return `image path \`${path}\` exceeded the allowed size of 10MB; resize or compress the image and try again`;
  }
  if (/unsupported image format|not a supported image/iu.test(message)) {
    return `image path \`${path}\` is not a supported image file`;
  }

  const name = error instanceof Error ? error.name : typeof error;
  return `unable to read image at \`${path}\`: ${name}`;
}

function parseApplyPatchInput(rawInput: string):
  | {
      ok: true;
      operations: ApplyPatchOperation[];
    }
  | {
      ok: false;
      error: string;
    } {
  const trimmedInput = rawInput.trimStart();
  if (trimmedInput.startsWith(BEGIN_PATCH)) {
    return parseFreeformPatch(trimmedInput);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid apply_patch JSON: ${toErrorMessage(error)}`,
    };
  }

  return parseApplyPatchPayload(payload);
}

function parseApplyPatchPayload(payload: unknown):
  | {
      ok: true;
      operations: ApplyPatchOperation[];
    }
  | {
      ok: false;
      error: string;
    } {
  if (typeof payload === 'string') {
    return parseFreeformPatch(payload);
  }
  if (Array.isArray(payload)) {
    return parseStructuredOperations(payload);
  }
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: 'apply_patch input must be an object or array.',
    };
  }
  if (typeof payload.patch === 'string') {
    return parseFreeformPatch(payload.patch);
  }
  if (Array.isArray(payload.command)) {
    const [commandName, patch] = payload.command;
    if (commandName === 'apply_patch' && typeof patch === 'string') {
      return parseFreeformPatch(patch);
    }
  }
  if (Array.isArray(payload.operations)) {
    return parseStructuredOperations(payload.operations);
  }
  if (payload.operation !== undefined) {
    return parseStructuredOperations([payload.operation]);
  }

  return parseStructuredOperations([payload]);
}

function parseStructuredOperations(payloads: unknown[]):
  | {
      ok: true;
      operations: ApplyPatchOperation[];
    }
  | {
      ok: false;
      error: string;
    } {
  const operations: ApplyPatchOperation[] = [];
  for (const payload of payloads) {
    const parsed = ApplyPatchOperation.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid apply_patch operation: ${parsed.error.message}`,
      };
    }
    operations.push(parsed.data);
  }
  if (operations.length === 0) {
    return { ok: false, error: 'apply_patch input must include an operation.' };
  }
  return { ok: true, operations };
}

function parseFreeformPatch(rawPatch: string):
  | {
      ok: true;
      operations: ApplyPatchOperation[];
    }
  | {
      ok: false;
      error: string;
    } {
  const lines = rawPatch.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines[0] !== BEGIN_PATCH) {
    return {
      ok: false,
      error: `apply_patch input must start with "${BEGIN_PATCH}".`,
    };
  }
  if (lines.length < 2 || lines.at(-1) !== END_PATCH) {
    return {
      ok: false,
      error: `apply_patch input must end with "${END_PATCH}".`,
    };
  }

  const operations: ApplyPatchOperation[] = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index]!;
    let parsed:
      | {
          operation: ApplyPatchOperation;
          nextIndex: number;
        }
      | {
          error: string;
        };
    if (line.startsWith(ADD_FILE)) {
      parsed = parseAddFilePatch(lines, index);
    } else if (line.startsWith(DELETE_FILE)) {
      parsed = parseDeleteFilePatch(lines, index);
    } else if (line.startsWith(UPDATE_FILE)) {
      parsed = parseUpdateFilePatch(lines, index);
    } else {
      return {
        ok: false,
        error: `Invalid apply_patch file operation header: ${line}`,
      };
    }

    if ('error' in parsed) {
      return { ok: false, error: parsed.error };
    }
    operations.push(parsed.operation);
    index = parsed.nextIndex;
  }

  if (operations.length === 0) {
    return {
      ok: false,
      error: 'apply_patch input must include at least one file operation.',
    };
  }
  return { ok: true, operations };
}

function parseAddFilePatch(
  lines: string[],
  index: number,
):
  | {
      operation: ApplyPatchOperation;
      nextIndex: number;
    }
  | {
      error: string;
    } {
  const path = parsePatchHeader(lines[index]!, ADD_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }

  index += 1;
  const diffLines: string[] = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    const line = lines[index]!;
    if (!line.startsWith('+')) {
      return { error: `Invalid Add File line: ${line}` };
    }
    diffLines.push(line);
    index += 1;
  }
  if (diffLines.length === 0) {
    return {
      error: `Add File patch for ${path} must include at least one + line.`,
    };
  }
  return {
    operation: {
      type: 'create_file',
      path,
      diff: joinDiff(diffLines),
    },
    nextIndex: index,
  };
}

function parseDeleteFilePatch(
  lines: string[],
  index: number,
):
  | {
      operation: ApplyPatchOperation;
      nextIndex: number;
    }
  | {
      error: string;
    } {
  const path = parsePatchHeader(lines[index]!, DELETE_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }
  index += 1;
  if (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    return { error: `Delete File patch for ${path} must not include a diff.` };
  }
  return {
    operation: {
      type: 'delete_file',
      path,
    },
    nextIndex: index,
  };
}

function parseUpdateFilePatch(
  lines: string[],
  index: number,
):
  | {
      operation: ApplyPatchOperation;
      nextIndex: number;
    }
  | {
      error: string;
    } {
  const path = parsePatchHeader(lines[index]!, UPDATE_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }

  index += 1;
  let moveTo: string | undefined;
  if (index < lines.length - 1 && lines[index]!.startsWith(MOVE_TO)) {
    const parsedMoveTo = parsePatchHeader(lines[index]!, MOVE_TO);
    if (!parsedMoveTo) {
      return { error: `Missing path in apply_patch header: ${lines[index]}` };
    }
    moveTo = parsedMoveTo;
    index += 1;
  }

  const diffLines: string[] = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index]!)) {
    diffLines.push(lines[index]!);
    index += 1;
  }
  if (diffLines.length === 0 && !moveTo) {
    return { error: `Update File patch for ${path} must include a hunk.` };
  }

  return {
    operation: {
      type: 'update_file',
      path,
      diff: diffLines.length > 0 ? joinDiff(diffLines) : '',
      ...(moveTo ? { moveTo } : {}),
    },
    nextIndex: index,
  };
}

function parsePatchHeader(line: string, prefix: string): string | null {
  const path = line.slice(prefix.length).trim();
  return path ? path : null;
}

function isFileOperationHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE)
  );
}

function joinDiff(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

async function applyPatchOperation(
  editor: Editor,
  operation: ApplyPatchOperation,
  runContext: Parameters<FunctionTool['invoke']>[0],
): Promise<string> {
  let result: ApplyPatchResult | void;
  try {
    switch (operation.type) {
      case 'create_file':
        result = await editor.createFile(operation, { runContext });
        break;
      case 'update_file':
        result = await editor.updateFile(operation, { runContext });
        break;
      case 'delete_file':
        result = await editor.deleteFile(operation, { runContext });
        break;
      default:
        return 'Unsupported apply_patch operation.';
    }
  } catch (error) {
    return `Failed to apply patch: ${toErrorMessage(error)}`;
  }

  if (result?.status === 'failed') {
    return result.output ? `Patch failed: ${result.output}` : 'Patch failed.';
  }
  return result?.output ?? 'Patch applied.';
}

async function applyPatchOperations(
  editor: Editor,
  operations: ApplyPatchOperation[],
  runContext: Parameters<FunctionTool['invoke']>[0],
): Promise<string> {
  const outputs: string[] = [];
  for (const operation of operations) {
    const output = await applyPatchOperation(editor, operation, runContext);
    if (output) {
      outputs.push(output);
    }
  }
  return outputs.join('\n') || 'Patch applied.';
}

function applyPatchFunctionTool(editor: Editor): FunctionTool {
  const fallbackTool: FunctionTool = {
    type: 'function',
    name: 'apply_patch',
    description:
      'Applies a create, update, move, or delete file patch in the sandbox workspace. Accepts a freeform patch string or structured apply_patch operations.',
    parameters: applyPatchFunctionParameters,
    strict: false,
    deferLoading: false,
    needsApproval: async () => false,
    isEnabled: async () => true,
    invoke: async (runContext, input) => {
      const parsed = parseApplyPatchInput(input);
      if (!parsed.ok) {
        return parsed.error;
      }

      return await applyPatchOperations(editor, parsed.operations, runContext);
    },
  };

  return fallbackTool;
}

class FilesystemCapability extends Capability {
  readonly type = 'filesystem';
  private readonly configureTools?: ConfigureCapabilityTools;

  constructor(args: FilesystemArgs = {}) {
    super();
    this.configureTools = args.configureTools;
  }

  override tools(): Tool<any>[] {
    const session = requireBoundSession(this.type, this._session);
    const editor = session.createEditor?.(this._runAs);
    if (!editor) {
      throw new UserError(
        'Filesystem sandbox sessions must provide createEditor().',
      );
    }

    const tools: Tool<any>[] = [];
    const viewImage = async (path: string): Promise<ViewImageToolResult> => {
      if (!session.viewImage) {
        throw new UserError(
          'Filesystem sandbox sessions must provide viewImage().',
        );
      }
      try {
        return await withSandboxSpan(
          'sandbox.view_image',
          {
            path,
            run_as: this._runAs,
          },
          async () =>
            await session.viewImage!({
              path,
              runAs: this._runAs,
            } satisfies ViewImageArgs),
        );
      } catch (error) {
        return renderViewImageError(path, error);
      }
    };

    if (supportsStructuredToolOutputTransport(this._modelInstance)) {
      tools.push(
        tool({
          name: 'view_image',
          description:
            'Returns an image output from a local path in the sandbox workspace.',
          parameters: z.object({
            path: z.string().describe('Local filesystem path to an image file'),
          }),
          execute: async ({
            path,
          }: {
            path: string;
          }): Promise<ViewImageToolResult> => await viewImage(path),
        }),
      );
    } else {
      tools.push(
        tool({
          name: 'view_image',
          description:
            'Returns an image from a local path in the sandbox workspace as a data URL or reference string.',
          parameters: z.object({
            path: z.string().describe('Local filesystem path to an image file'),
          }),
          execute: async ({ path }: { path: string }): Promise<string> =>
            renderImageForTextTransport(await viewImage(path)),
        }),
      );
    }

    if (supportsApplyPatchTransport(this._modelInstance)) {
      tools.push(
        applyPatchTool({
          name: 'apply_patch',
          editor,
        }),
      );
    } else {
      tools.push(applyPatchFunctionTool(editor));
    }

    return this.configureTools ? this.configureTools([...tools]) : tools;
  }
}

export type Filesystem = FilesystemCapability;

export function filesystem(args: FilesystemArgs = {}): Filesystem {
  return new FilesystemCapability(args);
}
