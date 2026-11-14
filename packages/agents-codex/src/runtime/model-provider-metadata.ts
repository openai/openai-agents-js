import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { copyJsonValue, type JsonObject } from './binding';

interface ProviderMetadata {
  readonly provider: string;
  readonly model: string;
  readonly value: JsonObject;
}
interface OutputMetadata {
  readonly output_index: number;
  readonly metadata: ProviderMetadata;
}
interface InputMetadata {
  readonly input_index: number;
  readonly item: JsonObject;
  readonly metadata: ProviderMetadata;
}
const responses = new WeakMap<
  object,
  { output: JsonObject[]; metadata: OutputMetadata[] }
>();
const requests = new WeakMap<object, InputMetadata[]>();
const streamFrames = new WeakMap<
  object,
  { metadata: OutputMetadata; encoded: string }
>();
const maxMetadataBytes = 8 * 1024 * 1024;
const maxMetadataItems = 4096;
export const modelTextPartMetadataKey = '__sdk_ai_sdk_text_parts';

function stripProviderControlFields(value: JsonObject): JsonObject {
  delete value.model;
  delete value.responseId;
  delete value.response_id;
  return value;
}

/** @internal Private metadata for ordered text parts of one assistant message. */
export function modelTextPartMetadata(
  values: readonly unknown[],
): JsonObject | undefined {
  const parts = values.map((value) => {
    const captured = mergeModelProviderMetadata(undefined, value);
    return captured ? stripProviderControlFields(captured) : null;
  });
  return parts.some((part) => part !== null)
    ? { [modelTextPartMetadataKey]: parts }
    : undefined;
}

/** @internal Data from the currently captured adapter, outside public model output. */
export function retainModelProviderMetadata(
  response: { output: readonly JsonObject[] },
  provider: string,
  model: string,
  values: readonly { outputIndex: number; value: unknown }[],
): void {
  if (!values.length) return;
  if (
    values.length > maxMetadataItems ||
    response.output.length > maxMetadataItems
  )
    throw new TypeError('Model provider metadata exceeds its response limit');
  const metadata = values.map(({ outputIndex, value }) => ({
    output_index: outputIndex,
    metadata: { provider, model, value: copyJsonValue(value) as JsonObject },
  }));
  if (
    metadata.length > maxMetadataItems ||
    response.output.length > maxMetadataItems ||
    Buffer.byteLength(JSON.stringify(metadata)) +
      Buffer.byteLength(JSON.stringify(response.output)) >
      maxMetadataBytes
  )
    throw new TypeError('Model provider metadata exceeds its response limit');
  if (
    !provider.trim() ||
    !model.trim() ||
    metadata.some(
      ({ output_index, metadata }) =>
        !Number.isSafeInteger(output_index) ||
        output_index < 0 ||
        output_index >= response.output.length ||
        !metadata.value ||
        typeof metadata.value !== 'object' ||
        Array.isArray(metadata.value),
    ) ||
    new Set(metadata.map((entry) => entry.output_index)).size !==
      metadata.length
  )
    throw new TypeError(
      'Model provider metadata requires exact output occurrences',
    );
  responses.set(response, {
    output: copyJsonValue(response.output) as JsonObject[],
    metadata,
  });
}

/** @internal Snapshot only when the exact produced output remains intact. */
export function captureModelProviderMetadata(response: {
  output: readonly JsonObject[];
}): JsonObject[] | undefined {
  const captured = responses.get(response);
  if (!captured) return undefined;
  if (!isDeepStrictEqual(response.output, captured.output))
    throw new TypeError(
      'Model provider metadata output changed before settlement',
    );
  return copyJsonValue(captured.metadata) as JsonObject[];
}

/** @internal Native captured prompt data, separate from the provider body. */
export function bindModelProviderMetadata(request: object, raw: unknown): void {
  if (raw == null) return;
  if (!Array.isArray(raw) || raw.length > maxMetadataItems)
    throw new TypeError('Invalid native model provider metadata');
  const data = copyJsonValue(raw);
  if (
    !Array.isArray(data) ||
    data.length > maxMetadataItems ||
    Buffer.byteLength(JSON.stringify(data)) > maxMetadataBytes
  )
    throw new TypeError('Invalid native model provider metadata');
  const entries = data as unknown as InputMetadata[];
  if (
    entries.some(
      (entry) =>
        !entry ||
        !Number.isSafeInteger(entry.input_index) ||
        entry.input_index < 0 ||
        !entry.item ||
        typeof entry.item !== 'object' ||
        Array.isArray(entry.item) ||
        typeof entry.metadata?.provider !== 'string' ||
        !entry.metadata.provider.trim() ||
        typeof entry.metadata.model !== 'string' ||
        !entry.metadata.model.trim() ||
        !entry.metadata.value ||
        typeof entry.metadata.value !== 'object' ||
        Array.isArray(entry.metadata.value),
    ) ||
    new Set(entries.map((entry) => entry.input_index)).size !== entries.length
  )
    throw new TypeError('Invalid native model provider metadata occurrence');
  requests.set(request, entries);
}

/** @internal Current logical provider/model scope, without stored configuration or credentials. */
export function replayModelProviderMetadata(
  request: object,
  inputIndex: number,
  item: JsonObject,
  provider: string,
  model: string,
): JsonObject | undefined {
  const entry = requests
    .get(request)
    ?.find((entry) => entry.input_index === inputIndex);
  if (
    !entry ||
    entry.metadata.provider !== provider ||
    entry.metadata.model !== model ||
    !isDeepStrictEqual(entry.item, item)
  )
    return;
  return stripProviderControlFields(
    copyJsonValue(entry.metadata.value) as JsonObject,
  );
}

/** @internal Private sidecar, before the native raw-observation projection. */
export function retainModelProviderStreamFrame(
  event: JsonObject,
  response: { output: readonly JsonObject[] },
  outputIndex: number,
): void {
  const captured = responses.get(response);
  const metadata = captured?.metadata.find(
    (entry) => entry.output_index === outputIndex,
  );
  if (!metadata || !captured) return;
  const expected = captured.output[outputIndex];
  const current = event.item as JsonObject;
  if (
    !expected ||
    event.type !== 'response.output_item.done' ||
    event.output_index !== outputIndex ||
    !isDeepStrictEqual(
      current,
      expected.id == null ? { ...expected, id: current.id } : expected,
    )
  )
    throw new TypeError(
      'Model provider stream metadata output changed before settlement',
    );
  streamFrames.set(event, { metadata, encoded: JSON.stringify(event) });
}

/** @internal Strip on native admission before provider/raw event delivery. */
export function captureModelProviderStreamFrame(
  encoded: string,
  event: JsonObject,
): string {
  const captured = streamFrames.get(event);
  if (!captured) return encoded;
  if (captured.encoded !== encoded)
    throw new TypeError(
      'Model provider stream output changed before settlement',
    );
  const metadata = captured.metadata;
  if (
    !encoded.startsWith('{') ||
    !encoded.endsWith('}') ||
    Object.hasOwn(event, '__sdk_model_provider_metadata')
  )
    throw new TypeError('Invalid model provider stream metadata envelope');
  return (
    encoded.slice(0, -1) +
    ',"__sdk_model_provider_metadata":' +
    JSON.stringify(metadata) +
    '}'
  );
}

/** @internal Opaque provider namespaces, captured without model/configuration adoption. */
export function mergeModelProviderMetadata(
  previous: JsonObject | undefined,
  next: unknown,
): JsonObject | undefined {
  if (next == null) return previous;
  const captured = copyJsonValue(next);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured))
    throw new TypeError('AI SDK provider metadata requires a JSON object');
  const merged = { ...previous };
  for (const [key, value] of Object.entries(captured)) {
    const existing = merged[key];
    Object.defineProperty(merged, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value:
        existing &&
        typeof existing === 'object' &&
        !Array.isArray(existing) &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
          ? { ...existing, ...value }
          : value,
    });
  }
  return merged;
}

export function hasModelProviderMetadata(
  request: object,
  inputIndex: number,
  item: JsonObject,
): boolean {
  const entry = requests
    .get(request)
    ?.find((entry) => entry.input_index === inputIndex);
  return entry !== undefined && isDeepStrictEqual(entry.item, item);
}
