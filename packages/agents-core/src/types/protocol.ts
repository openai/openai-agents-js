import { z } from 'zod';

// ----------------------------
// Shared base types
// ----------------------------

/**
 * Every item in the protocol provides a `providerData` field to accommodate custom functionality
 * or new fields
 */
export const SharedBase = z.object({
  /**
   * Additional optional provider specific data. Used for custom functionality or model provider
   * specific fields.
   */
  providerData: z.record(z.string(), z.any()).optional(),
});

export type SharedBase = z.infer<typeof SharedBase>;

/**
 * Every item has a shared of shared item data including an optional ID.
 */
export const ItemBase = SharedBase.extend({
  /**
   * An ID to identify the item. This is optional by default. If a model provider absolutely
   * requires this field, it will be validated on the model level.
   */
  id: z.string().optional(),
});

export type ItemBase = z.infer<typeof ItemBase>;

// ----------------------------
// Content types
// ----------------------------

export const Refusal = SharedBase.extend({
  type: z.literal('refusal'),
  /**
   * The refusal explanation from the model.
   */
  refusal: z.string(),
});

export type Refusal = z.infer<typeof Refusal>;

export const OutputText = SharedBase.extend({
  type: z.literal('output_text'),
  /**
   * The text output from the model.
   */
  text: z.string(),
});

export type OutputText = z.infer<typeof OutputText>;

export const InputText = SharedBase.extend({
  type: z.literal('input_text'),
  /**
   * A text input for example a message from a user
   */
  text: z.string(),
});

export type InputText = z.infer<typeof InputText>;

export const ReasoningText = SharedBase.extend({
  type: z.literal('reasoning_text'),
  /**
   * A text input for example a message from a user
   */
  text: z.string(),
});

export type ReasoningText = z.infer<typeof ReasoningText>;

export const InputImage = SharedBase.extend({
  type: z.literal('input_image'),

  /**
   * The image input to the model. Could be provided inline (`image`), as a URL, or by reference to a
   * previously uploaded OpenAI file.
   */
  image: z
    // 1. image data
    .string()
    // 2.file ID for the image
    .or(z.object({ id: z.string().describe('OpenAI file ID') }))
    .describe(
      'Either base64 encoded image data, a data URL, or an object with a file ID.',
    )
    .optional(),

  /**
   * Controls the level of detail requested for image understanding tasks.
   * Future models may add new values, therefore this accepts any string.
   */
  detail: z.string().optional(),
});

export type InputImage = z.infer<typeof InputImage>;

export const InputFile = SharedBase.extend({
  type: z.literal('input_file'),

  /**
   * The file input to the model. Could be raw data, a URL, or an OpenAI file ID.
   * When passing a string, it is interpreted as inline data or a URL; use `{ id }` for file IDs.
   */
  file: z
    // 1. file data
    .string()
    .describe(
      'Either base64 encoded file data or a publicly accessible file URL',
    )
    // 2. file ID
    .or(z.object({ id: z.string().describe('OpenAI file ID') }))
    // 3. publicly accessible file URL
    .or(z.object({ url: z.string().describe('Publicly accessible file URL') }))
    .describe('Contents of the file or an object with a file ID.')
    .optional(),

  /**
   * Optional filename metadata when uploading file data inline.
   */
  filename: z.string().optional(),
});

export type InputFile = z.infer<typeof InputFile>;

export const AudioContent = SharedBase.extend({
  type: z.literal('audio'),

  /**
   * The audio input to the model. Could be base64 encoded audio data or an object with a file ID.
   */
  audio: z
    .string()
    .or(
      z.object({
        id: z.string(),
      }),
    )
    .describe('Base64 encoded audio data or file id'),

  /**
   * The format of the audio.
   */
  format: z.string().nullable().optional(),

  /**
   * The transcript of the audio.
   */
  transcript: z.string().nullable().optional(),
});

export type AudioContent = z.infer<typeof AudioContent>;

export const ImageContent = SharedBase.extend({
  type: z.literal('image'),

  /**
   * The image input to the model. Could be base64 encoded image data or an object with a file ID.
   */
  image: z.string().describe('Base64 encoded image data'),
});

export type ImageContent = z.infer<typeof ImageContent>;

export const ToolOutputText = SharedBase.extend({
  type: z.literal('text'),

  /**
   * The text output from the model.
   */
  text: z.string(),
});

export type ToolOutputText = z.infer<typeof ToolOutputText>;

const ImageDataObjectSchema = z.object({
  data: z
    .union([z.string(), z.instanceof(Uint8Array)])
    .describe(
      'Base64 image data, or raw bytes that will be base64 encoded automatically.',
    ),
  mediaType: z.string().optional(),
});

const ImageUrlObjectSchema = z.object({
  url: z
    .string()
    .describe('Publicly accessible URL pointing to the image content'),
});

const ImageFileIdObjectSchema = z.object({
  fileId: z
    .string()
    .describe('OpenAI file ID referencing uploaded image content'),
});

const ImageObjectSchema = z
  .union([ImageDataObjectSchema, ImageUrlObjectSchema, ImageFileIdObjectSchema])
  .describe('Inline image data or references to uploaded content.');

const FileDataObjectSchema = z.object({
  data: z
    .union([z.string(), z.instanceof(Uint8Array)])
    .describe(
      'Base64 encoded file data, or raw bytes that will be encoded automatically.',
    ),
  mediaType: z
    .string()
    .describe('IANA media type describing the file contents'),
  filename: z.string().describe('Filename associated with the inline data'),
});

const FileUrlObjectSchema = z.object({
  url: z.string().describe('Publicly accessible URL for the file content'),
  filename: z.string().optional(),
});

const FileIdObjectSchema = z.object({
  id: z.string().describe('OpenAI file ID referencing uploaded content'),
  filename: z.string().optional(),
});

const FileReferenceSchema = z
  .union([
    z.string().describe('Existing data URL or base64 string'),
    FileDataObjectSchema,
    FileUrlObjectSchema,
    FileIdObjectSchema,
  ])
  .describe(
    'Inline data (with metadata) or references pointing to file contents.',
  );

const zStringWithHints = <T extends string>(..._hints: T[]) =>
  z.string() as unknown as z.ZodType<T | (string & {})>;

export const ToolOutputImage = SharedBase.extend({
  type: z.literal('image'),

  /**
   * Inline image content or a reference to an uploaded file. Accepts a URL/data URL string or an
   * object describing the data/url/fileId source.
   */
  image: z.string().or(ImageObjectSchema).optional(),

  /**
   * Controls the requested level of detail for vision models.
   * Use a string to avoid constraining future model capabilities.
   */
  detail: zStringWithHints('low', 'high', 'auto').optional(),
});

export type ToolOutputImage = z.infer<typeof ToolOutputImage>;

export const ToolOutputFileContent = SharedBase.extend({
  type: z.literal('file'),

  /**
   * File output reference. Provide either a string (data URL / base64), a data object (requires
   * mediaType + filename), or an object pointing to an uploaded file/URL.
   */
  file: FileReferenceSchema,
});

export type ToolOutputFileContent = z.infer<typeof ToolOutputFileContent>;

export const ComputerToolOutput = SharedBase.extend({
  type: z.literal('computer_screenshot'),

  /**
   * A base64 encoded image data or a URL representing the screenshot.
   */
  data: z.string().describe('Base64 encoded image data or URL'),
});

export type ComputerToolOutput = z.infer<typeof ComputerToolOutput>;

export const computerActions = z.discriminatedUnion('type', [
  z.object({ type: z.literal('screenshot') }),
  z.object({
    type: z.literal('click'),
    x: z.number(),
    y: z.number(),
    button: z.enum(['left', 'right', 'wheel', 'back', 'forward']),
  }),
  z.object({
    type: z.literal('double_click'),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal('scroll'),
    x: z.number(),
    y: z.number(),
    scroll_x: z.number(),
    scroll_y: z.number(),
  }),
  z.object({
    type: z.literal('type'),
    text: z.string(),
  }),
  z.object({ type: z.literal('wait') }),
  z.object({
    type: z.literal('move'),
    x: z.number(),
    y: z.number(),
  }),
  z.object({
    type: z.literal('keypress'),
    keys: z.array(z.string()),
  }),
  z.object({
    type: z.literal('drag'),
    path: z.array(z.object({ x: z.number(), y: z.number() })),
  }),
]);

export type ComputerAction = z.infer<typeof computerActions>;

// ----------------------------
// Message types
// ----------------------------

export const AssistantContent = z.discriminatedUnion('type', [
  OutputText,
  Refusal,
  AudioContent,
  ImageContent,
]);

export type AssistantContent = z.infer<typeof AssistantContent>;

const MessageBase = ItemBase.extend({
  /**
   * Any item without a type is treated as a message
   */
  type: z.literal('message').optional(),
});

export const AssistantMessageItem = MessageBase.extend({
  /**
   * Representing a message from the assistant (i.e. the model)
   */
  role: z.literal('assistant'),

  /**
   * The status of the message.
   */
  status: z.enum(['in_progress', 'completed', 'incomplete']),

  /**
   * The content of the message.
   */
  content: z.array(AssistantContent),
});

export type AssistantMessageItem = z.infer<typeof AssistantMessageItem>;

export const UserContent = z.discriminatedUnion('type', [
  InputText,
  InputImage,
  InputFile,
  AudioContent,
]);

export type UserContent = z.infer<typeof UserContent>;

export const UserMessageItem = MessageBase.extend({
  // type: z.literal('message'),

  /**
   * Representing a message from the user
   */
  role: z.literal('user'),

  /**
   * The content of the message.
   */
  content: z.array(UserContent).or(z.string()),
});

export type UserMessageItem = z.infer<typeof UserMessageItem>;

const SystemMessageItem = MessageBase.extend({
  // type: z.literal('message'),

  /**
   * Representing a system message to the user
   */
  role: z.literal('system'),

  /**
   * The content of the message.
   */
  content: z.string(),
});

export type SystemMessageItem = z.infer<typeof SystemMessageItem>;

export const MessageItem = z.discriminatedUnion('role', [
  SystemMessageItem,
  AssistantMessageItem,
  UserMessageItem,
]);

export type MessageItem = z.infer<typeof MessageItem>;

// ----------------------------
// Tool call types
// ----------------------------

export const HostedToolCallItem = ItemBase.extend({
  type: z.literal('hosted_tool_call'),
  /**
   * The name of the hosted tool. For example `web_search_call` or `file_search_call`
   */
  name: z.string().describe('The name of the hosted tool'),

  /**
   * The arguments of the hosted tool call.
   */
  arguments: z
    .string()
    .describe('The arguments of the hosted tool call')
    .optional(),

  /**
   * The status of the tool call.
   */
  status: z.string().optional(),

  /**
   * The primary output of the tool call. Additional output might be in the `providerData` field.
   */
  output: z.string().optional(),
});

export type HostedToolCallItem = z.infer<typeof HostedToolCallItem>;

export const FunctionCallItem = ItemBase.extend({
  type: z.literal('function_call'),
  /**
   * The ID of the tool call. Required to match up the respective tool call result.
   */
  callId: z.string().describe('The ID of the tool call'),

  /**
   * The name of the function.
   */
  name: z.string().describe('The name of the function'),

  /**
   * The status of the function call.
   */
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),

  /**
   * The arguments of the function call.
   */
  arguments: z.string(),
});

export type FunctionCallItem = z.infer<typeof FunctionCallItem>;

export const ToolCallOutputContent = z.discriminatedUnion('type', [
  ToolOutputText,
  ToolOutputImage,
  ToolOutputFileContent,
]);

export type ToolCallOutputContent = z.infer<typeof ToolCallOutputContent>;

export const ToolCallStructuredOutput = z.discriminatedUnion('type', [
  InputText,
  InputImage,
  InputFile,
]);

export type ToolCallStructuredOutput = z.infer<typeof ToolCallStructuredOutput>;

export const FunctionCallResultItem = ItemBase.extend({
  type: z.literal('function_call_result'),
  /**
   * The name of the tool that was called
   */
  name: z.string().describe('The name of the tool'),

  /**
   * The ID of the tool call. Required to match up the respective tool call result.
   */
  callId: z.string().describe('The ID of the tool call'),

  /**
   * The status of the tool call.
   */
  status: z.enum(['in_progress', 'completed', 'incomplete']),

  /**
   * The output of the tool call.
   */
  output: z
    .union([
      z.string(),
      ToolCallOutputContent,
      z.array(ToolCallStructuredOutput),
    ])
    .describe(
      'Output returned by the tool call. Supports plain strings, legacy ToolOutput items, or structured input_* items.',
    ),
});

export type FunctionCallResultItem = z.infer<typeof FunctionCallResultItem>;

export const ComputerUseCallItem = ItemBase.extend({
  type: z.literal('computer_call'),

  /**
   * The ID of the computer call. Required to match up the respective computer call result.
   */
  callId: z.string().describe('The ID of the computer call'),

  /**
   * The status of the computer call.
   */
  status: z.enum(['in_progress', 'completed', 'incomplete']),

  /**
   * The action to be performed by the computer.
   */
  action: computerActions,
});

export type ComputerUseCallItem = z.infer<typeof ComputerUseCallItem>;

export const ComputerCallResultItem = ItemBase.extend({
  type: z.literal('computer_call_result'),

  /**
   * The ID of the computer call. Required to match up the respective computer call result.
   */
  callId: z.string().describe('The ID of the computer call'),

  /**
   * The output of the computer call.
   */
  output: ComputerToolOutput,
});

export type ComputerCallResultItem = z.infer<typeof ComputerCallResultItem>;

export const ShellAction = z.object({
  commands: z.array(z.string()),
  timeoutMs: z.number().int().min(0).optional(),
  maxOutputLength: z.number().int().min(0).optional(),
});

export type ShellAction = z.infer<typeof ShellAction>;

export const ShellCallItem = ItemBase.extend({
  type: z.literal('shell_call'),
  callId: z.string(),
  status: z.enum(['in_progress', 'completed', 'incomplete']).optional(),
  action: ShellAction,
});

export type ShellCallItem = z.infer<typeof ShellCallItem>;

export const ShellCallOutcome = z.discriminatedUnion('type', [
  z.object({ type: z.literal('timeout') }),
  z.object({
    type: z.literal('exit'),
    exitCode: z.number().int().nullable(),
  }),
]);

export type ShellCallOutcome = z.infer<typeof ShellCallOutcome>;

export const ShellCallOutputContent = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    outcome: ShellCallOutcome,
  })
  .passthrough();

export type ShellCallOutputContent = z.infer<typeof ShellCallOutputContent>;

export const ShellCallResultItem = ItemBase.extend({
  type: z.literal('shell_call_output'),
  callId: z.string(),
  maxOutputLength: z.number().optional(),
  output: z.array(ShellCallOutputContent),
});

export type ShellCallResultItem = z.infer<typeof ShellCallResultItem>;

export const ApplyPatchOperationCreateFile = z.object({
  type: z.literal('create_file'),
  path: z.string(),
  diff: z.string(),
});

export type ApplyPatchOperationCreateFile = z.infer<
  typeof ApplyPatchOperationCreateFile
>;

export const ApplyPatchOperationUpdateFile = z.object({
  type: z.literal('update_file'),
  path: z.string(),
  diff: z.string(),
});

export type ApplyPatchOperationUpdateFile = z.infer<
  typeof ApplyPatchOperationUpdateFile
>;

export const ApplyPatchOperationDeleteFile = z.object({
  type: z.literal('delete_file'),
  path: z.string(),
});

export type ApplyPatchOperationDeleteFile = z.infer<
  typeof ApplyPatchOperationDeleteFile
>;

export const ApplyPatchOperation = z.discriminatedUnion('type', [
  ApplyPatchOperationCreateFile,
  ApplyPatchOperationUpdateFile,
  ApplyPatchOperationDeleteFile,
]);

export type ApplyPatchOperation = z.infer<typeof ApplyPatchOperation>;

export const ApplyPatchCallItem = ItemBase.extend({
  type: z.literal('apply_patch_call'),
  callId: z.string(),
  status: z.enum(['in_progress', 'completed']),
  operation: ApplyPatchOperation,
});

export type ApplyPatchCallItem = z.infer<typeof ApplyPatchCallItem>;

export const ApplyPatchCallResultItem = ItemBase.extend({
  type: z.literal('apply_patch_call_output'),
  callId: z.string(),
  status: z.enum(['completed', 'failed']),
  output: z.string().optional(),
});

export type ApplyPatchCallResultItem = z.infer<typeof ApplyPatchCallResultItem>;

export const ToolCallItem = z.discriminatedUnion('type', [
  ComputerUseCallItem,
  ShellCallItem,
  ApplyPatchCallItem,
  FunctionCallItem,
  HostedToolCallItem,
]);

export type ToolCallItem = z.infer<typeof ToolCallItem>;

// ----------------------------
// Special item types
// ----------------------------

export const ReasoningItem = SharedBase.extend({
  id: z.string().optional(),
  type: z.literal('reasoning'),

  /**
   * The user facing representation of the reasoning. Additional information might be in the `providerData` field.
   */
  content: z.array(InputText),

  /**
   * The raw reasoning text from the model.
   */
  rawContent: z.array(ReasoningText).optional(),
});

export type ReasoningItem = z.infer<typeof ReasoningItem>;

export const CompactionItem = ItemBase.extend({
  type: z.literal('compaction'),
  /**
   * Encrypted payload returned by the compaction endpoint.
   */
  encrypted_content: z.string(),
  /**
   * Identifier for the compaction item.
   */
  id: z.string().optional(),
  /**
   * Identifier for the generator of this compaction item.
   */
  created_by: z.string().optional(),
});

export type CompactionItem = z.infer<typeof CompactionItem>;

/**
 * This is a catch all for items that are not part of the protocol.
 *
 * For example, a model might return an item that is not part of the protocol using this type.
 *
 * In that case everything returned from the model should be passed in the `providerData` field.
 *
 * This enables new features to be added to be added by a model provider without breaking the protocol.
 */
export const UnknownItem = ItemBase.extend({
  type: z.literal('unknown'),
});

export type UnknownItem = z.infer<typeof UnknownItem>;

// ----------------------------
// Joined item types
// ----------------------------

export const OutputModelItem = z.discriminatedUnion('type', [
  AssistantMessageItem,
  HostedToolCallItem,
  FunctionCallItem,
  ComputerUseCallItem,
  ShellCallItem,
  ApplyPatchCallItem,
  FunctionCallResultItem,
  ShellCallResultItem,
  ApplyPatchCallResultItem,
  ReasoningItem,
  CompactionItem,
  UnknownItem,
]);

export type OutputModelItem = z.infer<typeof OutputModelItem>;

export const ModelItem = z.union([
  UserMessageItem,
  AssistantMessageItem,
  SystemMessageItem,
  HostedToolCallItem,
  FunctionCallItem,
  ComputerUseCallItem,
  ShellCallItem,
  ApplyPatchCallItem,
  FunctionCallResultItem,
  ComputerCallResultItem,
  ShellCallResultItem,
  ApplyPatchCallResultItem,
  ReasoningItem,
  CompactionItem,
  UnknownItem,
]);

export type ModelItem = z.infer<typeof ModelItem>;

// ----------------------------
// Meta data types
// ----------------------------

export const RequestUsageData = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  inputTokensDetails: z.record(z.string(), z.number()).optional(),
  outputTokensDetails: z.record(z.string(), z.number()).optional(),
  endpoint: z.string().optional(),
});

export type RequestUsageData = z.infer<typeof RequestUsageData>;

export const UsageData = z.object({
  requests: z.number().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  inputTokensDetails: z
    .union([
      z.record(z.string(), z.number()),
      z.array(z.record(z.string(), z.number())),
    ])
    .optional(),
  outputTokensDetails: z
    .union([
      z.record(z.string(), z.number()),
      z.array(z.record(z.string(), z.number())),
    ])
    .optional(),
  requestUsageEntries: z.array(RequestUsageData).optional(),
});

export type UsageData = z.infer<typeof UsageData>;

// ----------------------------
// Stream event types
// ----------------------------

/**
 * Event returned by the model when new output text is available to stream to the user.
 */
export const StreamEventTextStream = SharedBase.extend({
  type: z.literal('output_text_delta'),
  /**
   * The delta text that was streamed by the modelto the user.
   */
  delta: z.string(),
});

export type StreamEventTextStream = z.infer<typeof StreamEventTextStream>;

/**
 * Event returned by the model when a new response is started.
 */
export const StreamEventResponseStarted = SharedBase.extend({
  type: z.literal('response_started'),
});

export type StreamEventResponseStarted = z.infer<
  typeof StreamEventResponseStarted
>;

/**
 * Event returned by the model when a response is completed.
 */
export const StreamEventResponseCompleted = SharedBase.extend({
  type: z.literal('response_done'),
  /**
   * The response from the model.
   */
  response: SharedBase.extend({
    /**
     * The ID of the response.
     */
    id: z.string(),

    /**
     * The usage data for the response.
     */
    usage: UsageData,

    /**
     * The output from the model.
     */
    output: z.array(OutputModelItem),
  }),
});

export type StreamEventResponseCompleted = z.infer<
  typeof StreamEventResponseCompleted
>;

/**
 * Event returned for every item that gets streamed to the model. Used to expose the raw events
 * from the model.
 */
export const StreamEventGenericItem = SharedBase.extend({
  type: z.literal('model'),
  event: z.any().describe('The event from the model'),
});
export type StreamEventGenericItem = z.infer<typeof StreamEventGenericItem>;

export const StreamEvent = z.discriminatedUnion('type', [
  StreamEventTextStream,
  StreamEventResponseCompleted,
  StreamEventResponseStarted,
  StreamEventGenericItem,
]);

export type StreamEvent =
  | StreamEventTextStream
  | StreamEventResponseCompleted
  | StreamEventResponseStarted
  | StreamEventGenericItem;
