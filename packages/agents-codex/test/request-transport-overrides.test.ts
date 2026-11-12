import { expect, it } from 'vitest';
import {
  captureModelSettings,
  modelOverrides,
  NativeProvider,
  type ModelSettings,
} from '../src/runtime/provider';

it('captures request transport values before caller mutation and projects outside the body', () => {
  const settings: ModelSettings = {
    extraHeaders: { 'X-Routing': 'current', 'X-Omit': null },
    extraQuery: {
      count: 2,
      filter: { enabled: true },
      tags: ['one', 'two'],
      empty: null,
    },
  };
  const captured = captureModelSettings(settings);
  (settings.extraHeaders as Record<string, string | null>)['X-Routing'] =
    'late';
  (settings.extraQuery!.tags as string[]).push('late');
  expect(modelOverrides(undefined, captured)).toEqual({
    request_controls: {
      request_transport: {
        headers: { 'x-routing': 'current', 'x-omit': null },
        query: {
          count: 2,
          filter: { enabled: true },
          tags: ['one', 'two'],
          empty: null,
        },
        query_nulls_as_empty: true,
      },
    },
  });
});

it('preserves omission, explicit clears and independent sparse patches', () => {
  expect(modelOverrides(undefined, {})).toEqual({});
  expect(modelOverrides(undefined, { extraHeaders: null })).toEqual({
    request_controls: { request_transport: { headers: null } },
  });
  expect(modelOverrides(undefined, { extraQuery: null })).toEqual({
    request_controls: {
      request_transport: { query: null, query_nulls_as_empty: true },
    },
  });
  expect(modelOverrides(undefined, { extraHeaders: {} })).toEqual({
    request_controls: { request_transport: { headers: {} } },
  });
});

it.each([
  'Authorization',
  'api-key',
  'Cookie',
  'x-sdk-sentinel-grant',
  'X-Codex-Turn-State',
  'Sec-WebSocket-Key',
])('refuses setting or omitting provider-owned %s', (name) => {
  for (const value of ['replacement', null])
    expect(() =>
      captureModelSettings({ extraHeaders: { [name]: value } }),
    ).toThrow('native transport/auth');
});

it('rejects duplicate names and malformed values before an async opening', () => {
  expect(() =>
    captureModelSettings({
      extraHeaders: { 'X-Same': 'one', 'x-same': 'two' },
    }),
  ).toThrow('duplicated');
  expect(() =>
    captureModelSettings({ extraHeaders: { 'x-line': 'one\ninjected' } }),
  ).toThrow('printable ASCII');
  expect(() => captureModelSettings({ extraQuery: { '': 'value' } })).toThrow(
    'nonempty',
  );
  expect(() => captureModelSettings({ extraQuery: { count: NaN } })).toThrow();
});

it('preserves constructor routing validation through the shared header guard', () => {
  expect(
    () => new NativeProvider({ headers: { Authorization: 'unowned' } }),
  ).toThrow('native transport/auth');
  expect(
    () => new NativeProvider({ headers: { 'x-routing': 'allowed' } }),
  ).not.toThrow();
});
