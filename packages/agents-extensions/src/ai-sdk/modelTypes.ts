import type {
  LanguageModelV2 as LanguageModelV2Base,
  LanguageModelV2CallOptions,
  LanguageModelV2FunctionTool,
} from '@ai-sdk/provider';

// Minimal compatibility type to allow V3/V4 models that follow the same shape as V2.
type LanguageModelV3OrV4Compatible = {
  specificationVersion: string;
  provider: string;
  modelId: string;
  supportedUrls: any;
  doGenerate: (options: any) => PromiseLike<any> | any;
  doStream: (
    options: any,
  ) =>
    | PromiseLike<{ stream: AsyncIterable<any> }>
    | { stream: AsyncIterable<any> }
    | any;
};

// Minimal provider tool shapes to avoid SDK type name drift across v2/v3/v4.
type LanguageModelV2ProviderDefinedTool = {
  type: 'provider-defined';
  id: string;
  name: string;
  args?: Record<string, any>;
};

type LanguageModelV2ProviderTool = {
  type: 'provider';
  id: string;
  name: string;
  args?: Record<string, any>;
};

export type LanguageModelV2ProviderToolCompat =
  LanguageModelV2ProviderDefinedTool | LanguageModelV2ProviderTool;

export type LanguageModelV2CallOptionsCompat = Omit<
  LanguageModelV2CallOptions,
  'tools'
> & {
  tools?: Array<
    LanguageModelV2FunctionTool | LanguageModelV2ProviderToolCompat
  >;
};

type LanguageModelV2Compat = Omit<
  LanguageModelV2Base,
  'doGenerate' | 'doStream'
> & {
  doGenerate: (
    options: LanguageModelV2CallOptionsCompat,
  ) => PromiseLike<any> | any;
  doStream: (
    options: LanguageModelV2CallOptionsCompat,
  ) =>
    | PromiseLike<{ stream: AsyncIterable<any> }>
    | { stream: AsyncIterable<any> }
    | any;
};

export type LanguageModelCompatible =
  LanguageModelV2Compat | LanguageModelV3OrV4Compatible;

export type AiSdkSpecificationVersion = 'v2' | 'v3' | 'v4' | 'unknown';
