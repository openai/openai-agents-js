import { inspect } from 'node:util';
import { expect, it } from 'vitest';
import {
  ChatGPTAppsMCP,
  HostedVerificationMCP,
  HttpMCP,
  mcpConfig,
} from '../../src/runtime/mcp';
import { prepareUserVerification } from '../../src/runtime/verification';

const registration = () =>
  new HostedVerificationMCP({
    url: 'http://127.0.0.1:5678/mcp',
    tools: ['search'],
  });
const source = () => ({
  mode: 'openai/userVerification',
  title: 'Approve an action',
  description: 'Untrusted service text',
  challenge: 'AQID',
});

it('requires an explicit host registration instead of an ordinary reserved server alias', () => {
  expect(
    () =>
      new HttpMCP({
        name: 'codex_apps',
        url: 'http://127.0.0.1:5678/mcp',
        tools: ['search'],
      }),
  ).toThrow();
  const ordinary = new HttpMCP({
    name: 'ordinary',
    url: 'http://127.0.0.1:5678/mcp',
    tools: ['search'],
  });
  expect(() =>
    prepareUserVerification(
      ordinary as HostedVerificationMCP,
      'ordinary',
      '1',
      source(),
    ),
  ).toThrow();
  expect(() =>
    prepareUserVerification(registration(), 'ordinary', '1', source()),
  ).toThrow();
});

it('fixes personal Apps transport and uses a distinct ChatGPT auth mode', () => {
  const apps = new ChatGPTAppsMCP({ tools: ['search'] });
  expect(mcpConfig([apps]).codex_apps).toMatchObject({
    url: 'https://chatgpt.com/backend-api/ps/mcp',
    auth: 'chatgpt',
  });
  expect(mcpConfig([apps]).codex_apps).not.toHaveProperty('http_headers');
  expect(
    () =>
      new ChatGPTAppsMCP({
        tools: ['search'],
        url: 'http://127.0.0.1',
      } as never),
  ).toThrow();
  expect(
    () =>
      new ChatGPTAppsMCP({
        tools: ['search'],
        bearerToken: 'other-principal',
      } as never),
  ).toThrow();
});

it('retains the original registration and gives each reader an independent challenge copy', () => {
  const original = registration();
  const input = source();
  const prepared = prepareUserVerification(
    original,
    'codex_apps',
    '873',
    input,
  );
  input.challenge = 'BAUG';
  const target = {} as {
    challenge: Uint8Array;
    title: string;
    serverName: string;
  };
  prepared.decorate(target);
  const first = target.challenge;
  first.fill(255);
  expect([...target.challenge]).toEqual([1, 2, 3]);
  expect(target.challenge).not.toBe(target.challenge);
  expect(target.title).toBe('Approve an action');
  expect(target.serverName).toBe('codex_apps');
  expect(JSON.stringify(target)).toBe('{}');
  expect(inspect(target)).not.toContain('AQID');
  expect(prepared.registrationMatches(original)).toBe(true);
  expect(prepared.registrationMatches(registration())).toBe(false);
});

it('encodes only a syntactically valid proof while preserving the exact native ID', () => {
  const prepared = prepareUserVerification(
    registration(),
    'codex_apps',
    '9007199254740993',
    source(),
  );
  const wire = prepared.encodeReply({
    credentialId: 'enrolled-credential',
    signature: 'BAUG',
  });
  expect(wire).toContain('"request_id":9007199254740993');
  expect(JSON.parse(wire)).toMatchObject({
    kind: 'accept_elicitation',
    server_name: 'codex_apps',
    content: { credentialId: 'enrolled-credential', signature: 'BAUG' },
  });
  expect(JSON.parse(prepared.encodeReply(null))).toMatchObject({
    kind: 'decline_elicitation',
  });
  expect(prepared.encodeReply(null)).not.toContain('content');
});

it.each([
  undefined,
  {},
  { credentialId: '', signature: 'BAUG' },
  { credentialId: 'credential', signature: 'BAUG=' },
  { credentialId: 'credential', signature: 'AAB' },
  { credentialId: 'credential', signature: '' },
  {
    credentialId: 'credential',
    signature: Buffer.alloc(129).toString('base64url'),
  },
  { credentialId: 'x'.repeat(1025), signature: 'BAUG' },
])(
  'refuses malformed or incomplete proof without preparing acceptance: %j',
  (value) => {
    const prepared = prepareUserVerification(
      registration(),
      'codex_apps',
      '873',
      source(),
    );
    expect(() => prepared.encodeReply(value)).toThrow(
      'Invalid verification proof',
    );
  },
);

it.each(['AAB', 'A', '', 'AQ ID', 'AQID==='])(
  'refuses malformed challenge encoding: %s',
  (challenge) => {
    expect(() =>
      prepareUserVerification(registration(), 'codex_apps', '873', {
        ...source(),
        challenge,
      }),
    ).toThrow();
  },
);
