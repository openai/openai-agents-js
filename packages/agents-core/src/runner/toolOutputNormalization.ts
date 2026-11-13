import type {
  ToolCallStructuredOutput,
  ToolOutputFileContent,
  ToolOutputImage,
  ToolOutputText,
} from '../types/protocol';
import * as protocol from '../types/protocol';
import { encodeUint8ArrayToBase64 } from '../utils/base64';
import { formatInlineData, getInlineMediaType } from '../utils/inlineData';

type StructuredToolOutput =
  ToolOutputText | ToolOutputImage | ToolOutputFileContent;

/**
 * Accepts whatever the tool returned and attempts to coerce it into the structured protocol
 * shapes we expose to downstream model adapters (input_text/input_image/input_file). Tools are
 * allowed to return either a single structured object or an array of them; anything else falls
 * back to the legacy string pipeline.
 */
export function normalizeStructuredToolOutputs(
  output: unknown,
): StructuredToolOutput[] | null {
  if (Array.isArray(output)) {
    if (output.length === 0) {
      return null;
    }
    const structured: StructuredToolOutput[] = [];
    for (const item of output) {
      const normalized = normalizeStructuredToolOutput(item);
      if (!normalized) {
        return null;
      }
      structured.push(normalized);
    }
    return structured;
  }
  const normalized = normalizeStructuredToolOutput(output);
  return normalized ? [normalized] : null;
}

// Execution is permissive. For checkpoint verification, record which source fields actually
// contributed to that same projection. Unused alternatives and dropped metadata remain visible.
class ProjectionEvidence {
  private readonly represented = new Map<object, Set<string>>();

  constructor(readonly restoreInlineData: (value: string) => string) {}

  include(source: object, ...keys: string[]): void {
    const fields = this.represented.get(source) ?? new Set<string>();
    for (const key of keys) fields.add(key);
    this.represented.set(source, fields);
  }

  get hasUnrepresentedFields(): boolean {
    for (const [source, fields] of this.represented) {
      if (Object.keys(source).some((key) => !fields.has(key))) return true;
    }
    return false;
  }
}

export function projectStructuredToolOutput(
  value: unknown,
  restoreInlineData: (value: string) => string,
) {
  const evidence = new ProjectionEvidence(restoreInlineData);
  const normalized = normalizeStructuredToolOutput(value, evidence);
  return (
    normalized && {
      item: convertStructuredToolOutputToInputItem(normalized),
      hasUnrepresentedFields: evidence.hasUnrepresentedFields,
    }
  );
}

function normalizeStructuredToolOutput(
  value: unknown,
  evidence?: ProjectionEvidence,
): StructuredToolOutput | null {
  if (!isRecord(value)) return null;
  let output: StructuredToolOutput;
  if (value.type === 'text' && typeof value.text === 'string') {
    output = { type: 'text', text: value.text };
    evidence?.include(value, 'text');
  } else if (value.type === 'image') {
    const image = normalizeImageValue(value, evidence);
    if (!image) return null;
    output = { type: 'image', image };
    if (isNonEmptyString(value.detail)) {
      output.detail = value.detail;
      evidence?.include(value, 'detail');
    }
  } else if (value.type === 'file') {
    const file = normalizeFileValue(value, evidence);
    if (!file) return null;
    output = { type: 'file', file };
  } else {
    return null;
  }

  evidence?.include(value, 'type');
  if (isRecord(value.providerData)) {
    output.providerData = value.providerData;
    if (!Array.isArray(value.providerData))
      evidence?.include(value, 'providerData');
  }
  return output;
}

function normalizeImageValue(
  value: Record<string, any>,
  evidence?: ProjectionEvidence,
): ToolOutputImage['image'] {
  const image = value.image;
  if (isNonEmptyString(image)) {
    evidence?.include(value, 'image');
    return image;
  }
  if (isRecord(image)) {
    if (isNonEmptyString(image.url)) {
      evidence?.include(value, 'image');
      evidence?.include(image, 'url');
      return image.url;
    }
    if (isInlineData(image.data)) {
      evidence?.include(value, 'image');
      return normalizeImageData(value, image, evidence);
    }
  }
  if (isNonEmptyString(value.imageUrl)) {
    evidence?.include(value, 'imageUrl');
    return value.imageUrl;
  }
  if (isInlineData(value.data))
    return normalizeImageData(value, value, evidence);
  if (isRecord(image)) {
    const key = isNonEmptyString(image.fileId) ? 'fileId' : 'id';
    if (isNonEmptyString(image[key])) {
      evidence?.include(value, 'image');
      evidence?.include(image, key);
      return { fileId: image[key] };
    }
  }
  if (isNonEmptyString(value.fileId)) {
    evidence?.include(value, 'fileId');
    return { fileId: value.fileId };
  }
  return undefined;
}

function normalizeImageData(
  value: Record<string, any>,
  source: Record<string, any>,
  evidence?: ProjectionEvidence,
): string {
  const mediaType = getInlineMediaType(source) ?? getInlineMediaType(value);
  const data =
    typeof source.data === 'string' && evidence
      ? evidence.restoreInlineData(source.data)
      : source.data;
  const projected = formatInlineData(data, mediaType);
  if (evidence) {
    evidence.include(source, 'data');
    if (mediaType && projected.startsWith(`data:${mediaType};base64,`)) {
      for (const record of [source, value]) {
        for (const key of ['mediaType', 'mimeType']) {
          if (record[key] === mediaType) evidence.include(record, key);
        }
      }
    }
  }
  return projected;
}

function isInlineData(value: unknown): value is string | Uint8Array {
  return (
    isNonEmptyString(value) || (value instanceof Uint8Array && value.length > 0)
  );
}

/**
 * Translates the normalized tool output into the protocol `input_*` items. This is the last hop
 * before we hand the data to model-specific adapters, so we generate the exact schema expected by
 * the protocol definitions.
 */
export function convertStructuredToolOutputToInputItem(
  output: StructuredToolOutput,
): ToolCallStructuredOutput {
  if (output.type === 'text') {
    const result: protocol.InputText = {
      type: 'input_text',
      text: output.text,
    };
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  if (output.type === 'image') {
    const result: protocol.InputImage = { type: 'input_image' };
    if (typeof output.detail === 'string' && output.detail.length > 0) {
      result.detail = output.detail;
    }
    if (typeof output.image === 'string' && output.image.length > 0) {
      result.image = output.image;
    } else if (isRecord(output.image)) {
      const imageObj = output.image as Record<string, any>;
      const inlineMediaType = getInlineMediaType(imageObj);
      if (isNonEmptyString(imageObj.url)) {
        result.image = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        result.image =
          inlineMediaType && !imageObj.data.startsWith('data:')
            ? asDataUrl(imageObj.data, inlineMediaType)
            : imageObj.data;
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        const base64 = encodeUint8ArrayToBase64(imageObj.data);
        result.image = asDataUrl(base64, inlineMediaType);
      } else {
        const referencedId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (referencedId) {
          result.image = { id: referencedId };
        }
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }

  if (output.type === 'file') {
    const result: protocol.InputFile = { type: 'input_file' };
    const fileValue = output.file;
    if (typeof fileValue === 'string') {
      result.file = fileValue;
    } else if (fileValue && typeof fileValue === 'object') {
      const record = fileValue as Record<string, any>;
      if ('data' in record && record.data) {
        const mediaType = record.mediaType ?? 'text/plain';
        if (typeof record.data === 'string') {
          result.file = asDataUrl(record.data, mediaType);
        } else {
          const base64 = encodeUint8ArrayToBase64(record.data);
          result.file = asDataUrl(base64, mediaType);
        }
      } else if (typeof record.url === 'string' && record.url.length > 0) {
        result.file = { url: record.url };
      } else {
        const referencedId =
          (typeof record.id === 'string' &&
            record.id.length > 0 &&
            record.id) ||
          (typeof record.fileId === 'string' && record.fileId.length > 0
            ? record.fileId
            : undefined);
        if (referencedId) {
          result.file = { id: referencedId };
        }
      }

      if (typeof record.filename === 'string' && record.filename.length > 0) {
        result.filename = record.filename;
      }
    }
    if (output.providerData) {
      result.providerData = output.providerData;
    }
    return result;
  }
  const exhaustiveCheck: never = output;
  return exhaustiveCheck;
}

type FileReferenceValue = ToolOutputFileContent['file'];

function normalizeFileValue(
  value: Record<string, any>,
  evidence?: ProjectionEvidence,
): FileReferenceValue | null {
  if (isNonEmptyString(value.file)) {
    evidence?.include(value, 'file');
    return value.file;
  }
  if (isRecord(value.file)) {
    const file = normalizeFileReference(value.file, false, evidence);
    if (file) {
      evidence?.include(value, 'file');
      return file;
    }
  }
  return normalizeFileReference(value, true, evidence);
}

function normalizeFileReference(
  source: Record<string, any>,
  legacy: boolean,
  evidence?: ProjectionEvidence,
): FileReferenceValue | null {
  const dataKey = legacy ? 'fileData' : 'data';
  const data = source[dataKey];
  if (isInlineData(data)) {
    if (
      !isNonEmptyString(source.mediaType) ||
      !isNonEmptyString(source.filename)
    )
      return null;
    evidence?.include(source, dataKey, 'mediaType', 'filename');
    return {
      data:
        typeof data === 'string'
          ? (evidence?.restoreInlineData(data) ?? data)
          : new Uint8Array(data),
      mediaType: source.mediaType,
      filename: source.filename,
    };
  }
  if (!legacy && data !== undefined) return null;

  const urlKey = legacy ? 'fileUrl' : 'url';
  const idKey = legacy || !isNonEmptyString(source.id) ? 'fileId' : 'id';
  const key = isNonEmptyString(source[urlKey]) ? urlKey : idKey;
  const reference = source[key];
  if (!isNonEmptyString(reference)) return null;
  evidence?.include(source, key);
  const result:
    { url: string; filename?: string } | { id: string; filename?: string } =
    key === urlKey ? { url: reference } : { id: reference };
  if (isNonEmptyString(source.filename)) {
    result.filename = source.filename;
    evidence?.include(source, 'filename');
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function asDataUrl(base64: string, mediaType?: string): string {
  return mediaType ? `data:${mediaType};base64,${base64}` : base64;
}
