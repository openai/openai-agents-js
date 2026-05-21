import { describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';
import type OpenAI from 'openai';
import { OpenAIAgentIdentity } from '../src/agentIdentity';

const DEFAULT_REGISTRATION_BASE_URL = 'https://auth.openai.com/api/accounts';

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function readUint32be(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, false);
}

function parseOpenSshEd25519PublicKey(publicKey: string): Uint8Array {
  const [, payload] = publicKey.split(' ');
  const bytes = sodium.from_base64(payload, sodium.base64_variants.ORIGINAL);
  let offset = 0;
  const typeLength = readUint32be(bytes, offset);
  offset += 4;
  const type = sodium.to_string(bytes.slice(offset, offset + typeLength));
  expect(type).toBe('ssh-ed25519');
  offset += typeLength;
  const keyLength = readUint32be(bytes, offset);
  offset += 4;
  return bytes.slice(offset, offset + keyLength);
}

function decodeAgentAssertion(header: string): Record<string, string> {
  const token = header.replace(/^AgentAssertion /, '');
  return JSON.parse(
    sodium.to_string(
      sodium.from_base64(token, sodium.base64_variants.URLSAFE_NO_PADDING),
    ),
  );
}

describe('OpenAIAgentIdentity', () => {
  it('registers a runtime and task, decrypts the task id, and signs AgentAssertion auth', async () => {
    await sodium.ready;

    let runtimePublicKey: Uint8Array | undefined;
    const post = vi.fn(async (path: string, options: { body: any }) => {
      if (path === `${DEFAULT_REGISTRATION_BASE_URL}/v1/agent/register`) {
        expect(options.body.abom).toEqual({
          agent_harness_id: 'agents-js',
          agent_version: '1.2.3',
          running_location: 'docker',
        });
        expect(options.body.capabilities).toEqual(['shell']);
        runtimePublicKey = parseOpenSshEd25519PublicKey(
          options.body.agent_public_key,
        );
        return { agent_runtime_id: 'runtime_123' };
      }

      if (
        path ===
        `${DEFAULT_REGISTRATION_BASE_URL}/v1/agent/runtime_123/task/register`
      ) {
        expect(runtimePublicKey).toBeDefined();
        expect(options.body.external_task_ref).toBe('run_456');
        const registrationPayload = `runtime_123:${options.body.timestamp}`;
        expect(
          sodium.crypto_sign_verify_detached(
            sodium.from_base64(
              options.body.signature,
              sodium.base64_variants.ORIGINAL,
            ),
            utf8Bytes(registrationPayload),
            runtimePublicKey!,
          ),
        ).toBe(true);

        const curvePublicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
          runtimePublicKey!,
        );
        return {
          encrypted_task_id: sodium.to_base64(
            sodium.crypto_box_seal(utf8Bytes('task_789'), curvePublicKey),
            sodium.base64_variants.ORIGINAL,
          ),
        };
      }

      throw new Error(`Unexpected path ${path}`);
    });
    const fakeClient = { post } as unknown as OpenAI;
    const identity = new OpenAIAgentIdentity({
      agentHarnessId: 'agents-js',
      agentVersion: '1.2.3',
      runningLocation: 'docker',
      capabilities: ['shell'],
    });

    const header = await identity.getAuthorizationHeader(fakeClient, {
      externalTaskRef: 'run_456',
    });

    expect(header).toMatch(/^AgentAssertion /);
    expect(post).toHaveBeenCalledTimes(2);
    const assertion = decodeAgentAssertion(header);
    expect(assertion.agent_runtime_id).toBe('runtime_123');
    expect(assertion.task_id).toBe('task_789');
    expect(typeof assertion.timestamp).toBe('string');
    expect(
      sodium.crypto_sign_verify_detached(
        sodium.from_base64(
          assertion.signature,
          sodium.base64_variants.ORIGINAL,
        ),
        utf8Bytes(`runtime_123:task_789:${assertion.timestamp}`),
        runtimePublicKey!,
      ),
    ).toBe(true);

    await identity.getAuthorizationHeader(fakeClient, {
      externalTaskRef: 'run_456',
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('uses a custom AuthAPI registration base URL when configured', async () => {
    await sodium.ready;

    let runtimePublicKey: Uint8Array | undefined;
    const post = vi.fn(async (path: string, options: { body: any }) => {
      if (path === 'https://auth.example.test/accounts/v1/agent/register') {
        runtimePublicKey = parseOpenSshEd25519PublicKey(
          options.body.agent_public_key,
        );
        return { agent_runtime_id: 'runtime_custom' };
      }

      if (
        path ===
        'https://auth.example.test/accounts/v1/agent/runtime_custom/task/register'
      ) {
        expect(runtimePublicKey).toBeDefined();
        const curvePublicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
          runtimePublicKey!,
        );
        return {
          encrypted_task_id: sodium.to_base64(
            sodium.crypto_box_seal(utf8Bytes('task_custom'), curvePublicKey),
            sodium.base64_variants.ORIGINAL,
          ),
        };
      }

      throw new Error(`Unexpected path ${path}`);
    });
    const fakeClient = { post } as unknown as OpenAI;
    const identity = new OpenAIAgentIdentity({
      agentHarnessId: 'agents-js',
      agentVersion: '1.2.3',
      runningLocation: 'docker',
      registrationBaseURL: 'https://auth.example.test/accounts/',
    });

    const header = await identity.getAuthorizationHeader(fakeClient);

    const assertion = decodeAgentAssertion(header);
    expect(assertion.agent_runtime_id).toBe('runtime_custom');
    expect(assertion.task_id).toBe('task_custom');
    expect(post).toHaveBeenCalledTimes(2);
  });
});
