import { expectTypeOf } from 'vitest';
import type {
  Session as ConvenienceSession,
  MCPReadResourceResult as ConvenienceResult,
  MCPPrompt as ConveniencePrompt,
  MCPPromptArgument as ConvenienceArgument,
  MCPPromptContent as ConvenienceContent,
  MCPPromptMessage as ConvenienceMessage,
  MCPGetPromptResult as ConveniencePromptResult,
} from '@openai/agents';
import type {
  Session,
  MCPListResourcesResult,
  MCPListResourceTemplatesResult,
  MCPReadResourceResult,
  MCPPrompt,
  MCPPromptArgument,
  MCPPromptContent,
  MCPPromptMessage,
  MCPGetPromptResult,
} from '../../src';

expectTypeOf<Session['listMcpPrompts']>().toEqualTypeOf<
  (server: string) => Promise<MCPPrompt[]>
>();
expectTypeOf<Session['getMcpPrompt']>().toEqualTypeOf<
  (
    server: string,
    name: string,
    args?: Readonly<Record<string, string>>,
  ) => Promise<MCPGetPromptResult>
>();
expectTypeOf<ConvenienceSession['listMcpPrompts']>().toEqualTypeOf<
  Session['listMcpPrompts']
>();
expectTypeOf<ConvenienceSession['getMcpPrompt']>().toEqualTypeOf<
  Session['getMcpPrompt']
>();
expectTypeOf<ConveniencePrompt>().toEqualTypeOf<MCPPrompt>();
expectTypeOf<ConvenienceArgument>().toEqualTypeOf<MCPPromptArgument>();
expectTypeOf<ConvenienceContent>().toEqualTypeOf<MCPPromptContent>();
expectTypeOf<ConvenienceMessage>().toEqualTypeOf<MCPPromptMessage>();
expectTypeOf<ConveniencePromptResult>().toEqualTypeOf<MCPGetPromptResult>();
expectTypeOf<MCPPrompt['icons']>().toEqualTypeOf<
  Record<string, unknown>[] | undefined
>();
expectTypeOf<MCPPromptArgument['title']>().toEqualTypeOf<string | undefined>();
expectTypeOf<
  Extract<MCPPromptContent, { type: 'image' }>['data']
>().toEqualTypeOf<string>();
expectTypeOf<
  Extract<MCPPromptContent, { type: 'audio' }>['mimeType']
>().toEqualTypeOf<string>();
expectTypeOf<MCPGetPromptResult['resultType']>().toEqualTypeOf<
  string | undefined
>();
expectTypeOf<Session['listMcpResources']>().toEqualTypeOf<
  (server: string, cursor?: string) => Promise<MCPListResourcesResult>
>();
expectTypeOf<Session['listMcpResourceTemplates']>().toEqualTypeOf<
  (server: string, cursor?: string) => Promise<MCPListResourceTemplatesResult>
>();
expectTypeOf<Session['readMcpResource']>().toEqualTypeOf<
  (server: string, uri: string) => Promise<MCPReadResourceResult>
>();
expectTypeOf<ConvenienceSession['listMcpResources']>().toEqualTypeOf<
  Session['listMcpResources']
>();
expectTypeOf<ConvenienceSession['listMcpResourceTemplates']>().toEqualTypeOf<
  Session['listMcpResourceTemplates']
>();
expectTypeOf<ConvenienceSession['readMcpResource']>().toEqualTypeOf<
  Session['readMcpResource']
>();
expectTypeOf<ConvenienceResult>().toEqualTypeOf<MCPReadResourceResult>();

expectTypeOf<MCPListResourcesResult['resultType']>().toEqualTypeOf<
  string | undefined
>();
expectTypeOf<MCPListResourceTemplatesResult['ttlMs']>().toEqualTypeOf<
  number | undefined
>();
expectTypeOf<MCPReadResourceResult['cacheScope']>().toEqualTypeOf<
  'public' | 'private' | undefined
>();
expectTypeOf<MCPReadResourceResult['_meta']>().toEqualTypeOf<
  Record<string, unknown> | undefined
>();
