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
  | ToolOutputText
  | ToolOutputImage
  | ToolOutputFileContent;

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

/**
 * Best-effort normalization of a single tool output item. If the object already matches the
 * protocol shape we simply cast it; otherwise we copy the recognised fields into the canonical
 * structure. Returning null lets the caller know we should revert to plain-string handling.
 */
function normalizeStructuredToolOutput(
  value: unknown,
): StructuredToolOutput | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value.type;
  if (type === 'text' && typeof value.text === 'string') {
    const output: ToolOutputText = { type: 'text', text: value.text };
    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'image') {
    const output: ToolOutputImage = { type: 'image' };

    let imageString: string | undefined;
    let imageFileId: string | undefined;
    const fallbackImageMediaType = getInlineMediaType(value);

    const imageField = value.image;
    if (typeof imageField === 'string' && imageField.length > 0) {
      imageString = imageField;
    } else if (isRecord(imageField)) {
      const imageObj = imageField as Record<string, any>;
      const inlineMediaType =
        getInlineMediaType(imageObj) ?? fallbackImageMediaType;
      if (isNonEmptyString(imageObj.url)) {
        imageString = imageObj.url;
      } else if (isNonEmptyString(imageObj.data)) {
        imageString = formatInlineData(imageObj.data, inlineMediaType);
      } else if (
        imageObj.data instanceof Uint8Array &&
        imageObj.data.length > 0
      ) {
        imageString = formatInlineData(imageObj.data, inlineMediaType);
      }

      if (!imageString) {
        const candidateId =
          (isNonEmptyString(imageObj.fileId) && imageObj.fileId) ||
          (isNonEmptyString(imageObj.id) && imageObj.id) ||
          undefined;
        if (candidateId) {
          imageFileId = candidateId;
        }
      }
    }

    if (
      !imageString &&
      typeof value.imageUrl === 'string' &&
      value.imageUrl.length > 0
    ) {
      imageString = value.imageUrl;
    }
    if (
      !imageFileId &&
      typeof value.fileId === 'string' &&
      value.fileId.length > 0
    ) {
      imageFileId = value.fileId;
    }

    if (
      !imageString &&
      typeof value.data === 'string' &&
      value.data.length > 0
    ) {
      imageString = fallbackImageMediaType
        ? formatInlineData(value.data, fallbackImageMediaType)
        : value.data;
    } else if (
      !imageString &&
      value.data instanceof Uint8Array &&
      value.data.length > 0
    ) {
      imageString = formatInlineData(value.data, fallbackImageMediaType);
    }
    if (typeof value.detail === 'string' && value.detail.length > 0) {
      output.detail = value.detail;
    }

    if (imageString) {
      output.image = imageString;
    } else if (imageFileId) {
      output.image = { fileId: imageFileId };
    } else {
      return null;
    }

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  if (type === 'file') {
    const fileValue = normalizeFileValue(value);
    if (!fileValue) {
      return null;
    }

    const output: ToolOutputFileContent = { type: 'file', file: fileValue };

    if (isRecord(value.providerData)) {
      output.providerData = value.providerData;
    }
    return output;
  }

  return null;
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
): FileReferenceValue | null {
  const directFile = value.file;
  if (typeof directFile === 'string' && directFile.length > 0) {
    return directFile;
  }

  const normalizedObject = normalizeFileObjectCandidate(directFile);
  if (normalizedObject) {
    return normalizedObject;
  }

  const legacyValue = normalizeLegacyFileValue(value);
  if (legacyValue) {
    return legacyValue;
  }

  return null;
}

function normalizeFileObjectCandidate(
  value: unknown,
): FileReferenceValue | null {
  if (!isRecord(value)) {
    return null;
  }

  if ('data' in value && value.data !== undefined) {
    const dataValue = value.data;
    const hasStringData = typeof dataValue === 'string' && dataValue.length > 0;
    const hasBinaryData =
      dataValue instanceof Uint8Array && dataValue.length > 0;
    if (!hasStringData && !hasBinaryData) {
      return null;
    }

    if (
      !isNonEmptyString(value.mediaType) ||
      !isNonEmptyString(value.filename)
    ) {
      return null;
    }

    return {
      data:
        typeof dataValue === 'string' ? dataValue : new Uint8Array(dataValue),
      mediaType: value.mediaType,
      filename: value.filename,
    };
  }

  if (isNonEmptyString(value.url)) {
    const result: { url: string; filename?: string } = { url: value.url };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  const referencedId =
    (isNonEmptyString(value.id) && value.id) ||
    (isNonEmptyString(value.fileId) && (value.fileId as string));
  if (referencedId) {
    const result: { id: string; filename?: string } = { id: referencedId };
    if (isNonEmptyString(value.filename)) {
      result.filename = value.filename;
    }
    return result;
  }

  return null;
}

function normalizeLegacyFileValue(
  value: Record<string, any>,
): FileReferenceValue | null {
  const filename =
    typeof value.filename === 'string' && value.filename.length > 0
      ? value.filename
      : undefined;
  const mediaType =
    typeof value.mediaType === 'string' && value.mediaType.length > 0
      ? value.mediaType
      : undefined;

  if (typeof value.fileData === 'string' && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: value.fileData, mediaType, filename };
  }

  if (value.fileData instanceof Uint8Array && value.fileData.length > 0) {
    if (!mediaType || !filename) {
      return null;
    }
    return { data: new Uint8Array(value.fileData), mediaType, filename };
  }

  if (typeof value.fileUrl === 'string' && value.fileUrl.length > 0) {
    const result: { url: string; filename?: string } = { url: value.fileUrl };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  if (typeof value.fileId === 'string' && value.fileId.length > 0) {
    const result: { id: string; filename?: string } = { id: value.fileId };
    if (filename) {
      result.filename = filename;
    }
    return result;
  }

  return null;
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
