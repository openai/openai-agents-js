import { describe, expect, it } from 'vitest';
import { HEADERS } from '../src/defaults';
import {
  applyHeadersToAccumulator,
  createHeaderAccumulator,
  headerAccumulatorToRecord,
  mergeHeadersIntoRecord,
  mergeQueryParamsIntoURL,
} from '../src/responsesTransportUtils';

describe('responsesTransportUtils', () => {
  it('treats null-valued plain-object headers as explicit unsets', () => {
    const requestHeaders: Record<string, string> = {
      ...HEADERS,
      'X-Existing': 'keep',
    };

    mergeHeadersIntoRecord(requestHeaders, {
      'User-Agent': null,
      'X-Existing': 'override',
      'X-New': 'new',
    });

    expect(requestHeaders['User-Agent']).toBeUndefined();
    expect(requestHeaders).not.toHaveProperty('User-Agent');
    expect(requestHeaders['X-Existing']).toBe('override');
    expect(requestHeaders['X-New']).toBe('new');
  });

  it('applies plain-object header nulls as unsets in the header accumulator', () => {
    const accumulator = createHeaderAccumulator();

    applyHeadersToAccumulator(accumulator, {
      'User-Agent': HEADERS['User-Agent'],
      'X-Client-Header': 'client',
    });
    applyHeadersToAccumulator(accumulator, {
      'User-Agent': null,
    });

    const headers = headerAccumulatorToRecord(accumulator);
    expect(headers).not.toHaveProperty('User-Agent');
    expect(headers['X-Client-Header']).toBe('client');
  });

  it('serializes Date query values as ISO-8601 strings', () => {
    const url = new URL('wss://proxy.example.test/v1/responses');
    const timestamp = new Date('2025-01-02T03:04:05.678Z');
    const nestedTimestamp = new Date('2025-04-06T07:08:09.010Z');
    const arrayTimestamp = new Date('2025-11-12T13:14:15.016Z');

    mergeQueryParamsIntoURL(url, {
      at: timestamp,
      filter: { since: nestedTimestamp },
      many: [arrayTimestamp],
    });

    expect(url.searchParams.get('at')).toBe(timestamp.toISOString());
    expect(url.searchParams.get('filter[since]')).toBe(
      nestedTimestamp.toISOString(),
    );
    expect(url.searchParams.get('many[]')).toBe(arrayTimestamp.toISOString());
    expect(url.searchParams.get('at[]')).toBeNull();
    expect(Array.from(url.searchParams.keys())).not.toContain('at[valueOf]');
  });
});
