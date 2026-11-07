import { expectTypeOf } from 'vitest';
import type {
  Session as ConvenienceSession,
  MCPReadResourceResult as ConvenienceResult,
} from '@openai/agents';
import type {
  Session,
  MCPListResourcesResult,
  MCPListResourceTemplatesResult,
  MCPReadResourceResult,
} from '../../src';
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
