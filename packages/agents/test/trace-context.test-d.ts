import { expectTypeOf } from 'vitest';
import { TraceContext } from '@openai/agents';

declare const context: TraceContext;
const headers = context.toHeaders();
expectTypeOf(headers.traceparent).toEqualTypeOf<string>();
expectTypeOf(headers.tracestate).toEqualTypeOf<string | undefined>();
const requestHeaders: HeadersInit = headers;
new Headers(headers);
// @ts-expect-error Missing tracestate requires a check before string access.
headers.tracestate.toLowerCase();
// @ts-expect-error Returned trace headers are immutable.
headers.traceparent = 'replacement';
void requestHeaders;
