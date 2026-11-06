import { expectTypeOf } from 'vitest';
import {
  Agent,
  webSearch,
  type ModelSettings,
  type Observation,
  type OutputTextPart,
  type SearchItem,
  type Session,
  type SessionItem,
  type Tool,
  type WebSearch,
  type WebSearchAction,
  type WebSearchLocation,
  type WebSearchSource,
} from '@openai/agents-codex';
import {
  webSearch as convenienceWebSearch,
  type SearchItem as ConvenienceSearchItem,
} from '@openai/agents';
const search = webSearch();
expectTypeOf(search).toEqualTypeOf<WebSearch>();
expectTypeOf(convenienceWebSearch).toEqualTypeOf<typeof webSearch>();
expectTypeOf<ConvenienceSearchItem>().toEqualTypeOf<SearchItem>();
const tools: Tool[] = [search];
new Agent({ instructions: 'Research', tools });
const location: WebSearchLocation = { timezone: 'America/Chicago' };
const hosted = webSearch({
  route: 'hosted',
  allowedDomains: ['example.test'],
  location,
});
const settings: ModelSettings = { toolChoice: 'required' };
new Agent({
  instructions: 'Research',
  tools: [hosted],
  modelSettings: settings,
});
expectTypeOf<ReturnType<Session['items']>>().toExtend<
  AsyncIterable<SessionItem>
>();
expectTypeOf<SearchItem>().toEqualTypeOf<
  Extract<SessionItem, { type: 'web_search_call' | 'message' }>
>();
expectTypeOf<
  Extract<Observation, { type: 'search_item_completed' }>['item']
>().toEqualTypeOf<SearchItem>();
expectTypeOf<
  Extract<WebSearchAction, { type: 'search' }>['sources']
>().toEqualTypeOf<WebSearchSource[] | undefined>();
expectTypeOf<
  Extract<
    Extract<SessionItem, { type: 'message' }>['content'][number],
    { type: 'output_text' }
  >
>().toEqualTypeOf<OutputTextPart>();
expectTypeOf<
  Extract<SessionItem, { type: 'message' }>['displayText']
>().toEqualTypeOf<string | undefined>();
// @ts-expect-error Search is enabled by omission or a captured cached/live grant, not a disabled descriptor.
webSearch({ mode: 'disabled' });
// @ts-expect-error No automatic fallback route is admitted.
webSearch({ route: 'auto' });
// @ts-expect-error Captured declarations are readonly.
search.mode = 'live';
// @ts-expect-error Captured domain lists are readonly.
hosted.allowedDomains?.push('example.test');
// @ts-expect-error The native public Agent accepts only the three outer choice strings.
settings.toolChoice = { type: 'web_search' };
