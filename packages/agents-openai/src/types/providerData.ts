import OpenAI from 'openai';

export type WebSearchTool = Omit<OpenAI.Responses.WebSearchTool, 'type'> & {
  type: 'web_search';
  name: 'web_search' | 'web_search_preview' | (string & {});
  // The Responses API supports these fields, but openai-node typings do not expose them yet.
  external_web_access?: boolean;
  search_content_types?: Array<'text' | 'image'>;
  image_settings?: {
    max_results?: number;
    caption?: boolean;
  };
};

export type FileSearchTool = Omit<OpenAI.Responses.FileSearchTool, 'type'> & {
  type: 'file_search';
  name: 'file_search' | (string & {});
  include_search_results?: boolean;
};

export type CodeInterpreterTool = Omit<
  OpenAI.Responses.Tool.CodeInterpreter,
  'type'
> & {
  type: 'code_interpreter';
  name: 'code_interpreter' | (string & {});
  include_outputs?: boolean;
};

export type ProgrammaticToolCallingTool = {
  type: 'programmatic_tool_calling';
};

export type ToolSearchTool = Omit<OpenAI.Responses.ToolSearchTool, 'type'> & {
  type: 'tool_search';
  name: 'tool_search';
};

export type ImageGenerationTool = Omit<
  OpenAI.Responses.Tool.ImageGeneration,
  | 'type'
  | 'background'
  | 'model'
  | 'moderation'
  | 'output_format'
  | 'quality'
  | 'size'
> & {
  type: 'image_generation';
  name: 'image_generation' | (string & {});
  background?: 'transparent' | 'opaque' | 'auto' | (string & {});
  model?: 'gpt-image-1' | 'gpt-image-1-mini' | 'gpt-image-1.5' | (string & {});
  moderation?: 'auto' | 'low' | (string & {});
  output_format?: 'png' | 'webp' | 'jpeg' | (string & {});
  quality?: 'low' | 'medium' | 'high' | 'auto' | (string & {});
  size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto' | (string & {});
};
