import { expect, it } from 'vitest';
import { ChatGPTAppsMCP, HostedVerificationMCP, HttpMCP } from '../../src';
import {
  mcpConfig,
  resourceMcpBinding,
  selectHttpLeaves,
} from '../../src/runtime/mcp';

const options = {
  name: 'records',
  tools: ['read'],
  url: 'https://example.invalid/mcp',
};

it('captures own header fields and preserves them through current selections', () => {
  const supplied = Object.assign(Object.create({ 'X-Inherited': 'excluded' }), {
    'X-Tenant': 'header-secret',
    'X-Empty': '',
    'X-Label': 'café\tvalue',
  });
  Object.defineProperty(supplied, '__proto__', {
    value: 'literal',
    enumerable: true,
  });
  const server = new HttpMCP({ ...options, headers: supplied });
  supplied['X-Tenant'] = 'later';
  expect(server.headers?.['X-Tenant']).toBe('header-secret');
  expect(Object.isFrozen(server.headers)).toBe(true);
  expect(server.headers).not.toHaveProperty('X-Inherited');
  expect(Object.hasOwn(server.headers!, '__proto__')).toBe(true);
  const first = mcpConfig([server]).records as any;
  first.http_headers['X-Tenant'] = 'changed';
  for (const selected of [
    selectHttpLeaves(server, []),
    resourceMcpBinding(server),
  ]) {
    expect((mcpConfig([selected]).records as any).http_headers).toEqual(
      server.headers,
    );
  }
  expect(Object.keys(server)).not.toContain('headers');
  expect(JSON.stringify(server)).not.toContain('header-secret');
});

it.each([
  ['array', []],
  ['number', 1],
  ['null', null],
  ['empty name', { '': 'header-secret' }],
  ['space in name', { 'bad name': 'header-secret' }],
  ['Unicode name', { é: 'header-secret' }],
  ['number value', { 'X-Value': 1 }],
  ['newline value', { 'X-Value': 'header-secret\r\ninjected' }],
  ['DEL value', { 'X-Value': 'header-secret\x7f' }],
  ['NUL value', { 'X-Value': 'header-secret\0' }],
  ['surrogate', { 'X-Value': 'header-secret\ud800' }],
  ['case collision', { 'X-Tenant': 'header-secret', 'x-tenant': 'another' }],
])(
  'rejects invalid header maps without echoing values: %s',
  (_label, headers) => {
    try {
      new HttpMCP({ ...options, headers: headers as never });
      throw new Error('Expected invalid headers to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).not.toContain('header-secret');
    }
  },
);

it('keeps bearer and custom authentication unambiguous', () => {
  const server = new HttpMCP({
    ...options,
    bearerToken: 'token',
    headers: { 'X-Tenant': 'tenant' },
  });
  expect((mcpConfig([server]).records as any).http_headers).toEqual({
    'X-Tenant': 'tenant',
    Authorization: 'Bearer token',
  });
  const basic = new HttpMCP({
    ...options,
    headers: { authorization: 'Basic value' },
  });
  expect((mcpConfig([basic]).records as any).http_headers).toEqual({
    authorization: 'Basic value',
  });
  for (const name of ['Authorization', 'authorization', 'AUTHORIZATION'])
    expect(
      () =>
        new HttpMCP({
          ...options,
          bearerToken: 'token',
          headers: { [name]: 'header-secret' },
        }),
    ).toThrow('either bearerToken');
  expect(
    mcpConfig([new HttpMCP({ ...options, headers: {} })]).records,
  ).not.toHaveProperty('http_headers');
});

it('keeps ChatGPT Apps authentication fixed while allowing custom verification headers', () => {
  for (const headers of [undefined, { 'X-Tenant': 'secret' }])
    expect(() => new ChatGPTAppsMCP({ tools: [], headers } as never)).toThrow(
      'fixed target',
    );
  const hosted = new HostedVerificationMCP({
    tools: [],
    url: options.url,
    headers: { 'X-Tenant': 'tenant' },
  });
  expect((mcpConfig([hosted]).codex_apps as any).http_headers).toEqual({
    'X-Tenant': 'tenant',
  });
});
