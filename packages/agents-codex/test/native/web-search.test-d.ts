import { expectTypeOf } from 'vitest';
import { Agent, webSearch, type Tool, type WebSearch } from '../../src';
const search = webSearch();
expectTypeOf(search).toEqualTypeOf<WebSearch>();
const tools: Tool[] = [search];
new Agent({ instructions: 'Research', tools });
// @ts-expect-error Search is enabled by omission or a captured cached/live grant, not a disabled descriptor.
webSearch({ mode: 'disabled' });
// @ts-expect-error No automatic fallback route is admitted.
webSearch({ route: 'auto' });
// @ts-expect-error Domain controls remain a separate classic hosted-search contract.
webSearch({ allowedDomains: ['example.test'] });
// @ts-expect-error Captured declarations are readonly.
search.mode = 'live';
