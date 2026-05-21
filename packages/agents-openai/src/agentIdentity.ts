import type OpenAI from 'openai';
import sodium from 'libsodium-wrappers-sumo';
import { METADATA } from './metadata';

const AGENT_ASSERTION_AUTHORIZATION_SCHEME = 'AgentAssertion';
const DEFAULT_TASK_CACHE_KEY = '__default__';
const DEFAULT_AGENT_HARNESS_ID = 'openai-agents-js';
const DEFAULT_AGENT_REGISTRATION_BASE_URL =
  'https://auth.openai.com/api/accounts';

type SodiumKeyPair = {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
};

type RegisterAgentResponse = {
  agent_runtime_id?: unknown;
};

type RegisterTaskResponse = {
  encrypted_task_id?: unknown;
};

type RegisteredRuntime = {
  agentRuntimeId: string;
  keyPair: SodiumKeyPair;
  agentPublicKey: string;
};

type RegisteredTask = {
  taskId: string;
};

export type OpenAIAgentIdentityOptions = {
  /**
   * Stable identifier for the SDK/harness registering this runtime.
   *
   * Examples: `agents-js`, `codex-cli`, or another product-specific harness id.
   */
  agentHarnessId: string;

  /**
   * Version of the running agent or harness.
   */
  agentVersion: string;

  /**
   * Logical location where the agent is running.
   *
   * Examples: `local`, `docker`, `e2b`, or a hosted runtime identifier.
   */
  runningLocation: string;

  /**
   * Capabilities authorized for this runtime registration.
   */
  capabilities?: string[];

  /**
   * Optional runtime TTL in seconds.
   */
  ttl?: number;

  /**
   * Optional durable task reference used when no per-request external task
   * reference is available from the runner.
   */
  externalTaskRef?: string;

  /**
   * Base URL for the AuthAPI agent registration surface.
   */
  registrationBaseURL?: string;
};

export type OpenAIAgentAssertionContext = {
  /**
   * Optional durable task reference. When present, task registration is cached
   * per external reference so retries/resumes can reuse the same task id.
   */
  externalTaskRef?: string;
};

export type OpenAIAgentIdentityInput =
  | OpenAIAgentIdentity
  | OpenAIAgentIdentityOptions
  | false;

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Agent identity response missing ${field}.`);
  }
  return value;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint32be(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function sshString(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? utf8Bytes(value) : value;
  return concatBytes([uint32be(bytes.length), bytes]);
}

function openSshEd25519PublicKey(publicKey: Uint8Array): string {
  const keyType = 'ssh-ed25519';
  const payload = concatBytes([sshString(keyType), sshString(publicKey)]);
  return `${keyType} ${sodium.to_base64(
    payload,
    sodium.base64_variants.ORIGINAL,
  )}`;
}

function utcTimestamp(): string {
  return new Date().toISOString();
}

function signBase64(keyPair: SodiumKeyPair, payload: string): string {
  return sodium.to_base64(
    sodium.crypto_sign_detached(utf8Bytes(payload), keyPair.privateKey),
    sodium.base64_variants.ORIGINAL,
  );
}

function serializeAgentAssertion(params: {
  agentRuntimeId: string;
  taskId: string;
  timestamp: string;
  signature: string;
}): string {
  // Keep the canonical key order aligned with the server-side sorted JSON
  // envelope used by AgentAssertion auth.
  const payload = JSON.stringify({
    agent_runtime_id: params.agentRuntimeId,
    signature: params.signature,
    task_id: params.taskId,
    timestamp: params.timestamp,
  });
  return sodium.to_base64(
    utf8Bytes(payload),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}

function decryptTaskId(
  encryptedTaskId: string,
  keyPair: SodiumKeyPair,
): string {
  const encrypted = sodium.from_base64(
    encryptedTaskId,
    sodium.base64_variants.ORIGINAL,
  );
  const publicKey = sodium.crypto_sign_ed25519_pk_to_curve25519(
    keyPair.publicKey,
  );
  const privateKey = sodium.crypto_sign_ed25519_sk_to_curve25519(
    keyPair.privateKey,
  );
  const decrypted = sodium.crypto_box_seal_open(
    encrypted,
    publicKey,
    privateKey,
  );
  return sodium.to_string(decrypted);
}

function taskCacheKey(externalTaskRef: string | undefined): string {
  return externalTaskRef ?? DEFAULT_TASK_CACHE_KEY;
}

function getDefaultRunningLocation(): string {
  const globalValue = globalThis as { window?: unknown };
  return typeof globalValue.window === 'undefined' ? 'node' : 'browser';
}

function registrationURL(baseURL: string, path: string): string {
  const url = new URL(baseURL);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${path}`;
  return url.toString();
}

/**
 * Registers an OpenAI agent runtime/task and mints verified AgentAssertion
 * authorization headers for Responses API calls.
 */
export class OpenAIAgentIdentity {
  readonly #options: OpenAIAgentIdentityOptions;
  readonly #registrationBaseURL: string;
  #runtimePromise?: Promise<RegisteredRuntime>;
  readonly #taskPromises = new Map<string, Promise<RegisteredTask>>();

  constructor(options: OpenAIAgentIdentityOptions) {
    this.#options = { ...options };
    this.#registrationBaseURL =
      options.registrationBaseURL ?? DEFAULT_AGENT_REGISTRATION_BASE_URL;
  }

  async getAuthorizationHeader(
    client: OpenAI,
    context: OpenAIAgentAssertionContext = {},
  ): Promise<string> {
    const runtime = await this.#getRuntime(client);
    const task = await this.#getTask(client, runtime, context.externalTaskRef);
    const timestamp = utcTimestamp();
    const signature = signBase64(
      runtime.keyPair,
      `${runtime.agentRuntimeId}:${task.taskId}:${timestamp}`,
    );
    const assertion = serializeAgentAssertion({
      agentRuntimeId: runtime.agentRuntimeId,
      taskId: task.taskId,
      timestamp,
      signature,
    });
    return `${AGENT_ASSERTION_AUTHORIZATION_SCHEME} ${assertion}`;
  }

  async #getRuntime(client: OpenAI): Promise<RegisteredRuntime> {
    this.#runtimePromise ??= this.#registerRuntime(client);
    return this.#runtimePromise;
  }

  async #registerRuntime(client: OpenAI): Promise<RegisteredRuntime> {
    await sodium.ready;
    const seed = sodium.randombytes_buf(sodium.crypto_sign_ed25519_SEEDBYTES);
    const keyPair = sodium.crypto_sign_seed_keypair(seed);
    const agentPublicKey = openSshEd25519PublicKey(keyPair.publicKey);
    const response = await client.post<RegisterAgentResponse>(
      registrationURL(this.#registrationBaseURL, '/v1/agent/register'),
      {
        body: {
          abom: {
            agent_harness_id: this.#options.agentHarnessId,
            agent_version: this.#options.agentVersion,
            running_location: this.#options.runningLocation,
          },
          agent_public_key: agentPublicKey,
          capabilities: this.#options.capabilities ?? [],
          ...(typeof this.#options.ttl === 'number'
            ? { ttl: this.#options.ttl }
            : {}),
        },
      },
    );

    return {
      agentRuntimeId: assertString(
        response.agent_runtime_id,
        'agent_runtime_id',
      ),
      keyPair,
      agentPublicKey,
    };
  }

  async #getTask(
    client: OpenAI,
    runtime: RegisteredRuntime,
    externalTaskRef: string | undefined,
  ): Promise<RegisteredTask> {
    const resolvedExternalTaskRef =
      externalTaskRef ?? this.#options.externalTaskRef;
    const cacheKey = taskCacheKey(resolvedExternalTaskRef);
    let taskPromise = this.#taskPromises.get(cacheKey);
    if (!taskPromise) {
      taskPromise = this.#registerTask(
        client,
        runtime,
        resolvedExternalTaskRef,
      );
      this.#taskPromises.set(cacheKey, taskPromise);
    }
    return taskPromise;
  }

  async #registerTask(
    client: OpenAI,
    runtime: RegisteredRuntime,
    externalTaskRef: string | undefined,
  ): Promise<RegisteredTask> {
    const timestamp = utcTimestamp();
    const signature = signBase64(
      runtime.keyPair,
      `${runtime.agentRuntimeId}:${timestamp}`,
    );
    const response = await client.post<RegisterTaskResponse>(
      registrationURL(
        this.#registrationBaseURL,
        `/v1/agent/${runtime.agentRuntimeId}/task/register`,
      ),
      {
        body: {
          timestamp,
          signature,
          ...(externalTaskRef ? { external_task_ref: externalTaskRef } : {}),
        },
      },
    );
    const encryptedTaskId = assertString(
      response.encrypted_task_id,
      'encrypted_task_id',
    );
    return {
      taskId: decryptTaskId(encryptedTaskId, runtime.keyPair),
    };
  }
}

export function getDefaultOpenAIAgentIdentityOptions(): OpenAIAgentIdentityOptions {
  return {
    agentHarnessId: DEFAULT_AGENT_HARNESS_ID,
    agentVersion: METADATA.version,
    runningLocation: getDefaultRunningLocation(),
    registrationBaseURL: DEFAULT_AGENT_REGISTRATION_BASE_URL,
  };
}

export function resolveOpenAIAgentIdentity(
  identity: OpenAIAgentIdentityInput | undefined,
): OpenAIAgentIdentity | undefined {
  if (identity === false || !identity) {
    return undefined;
  }
  return identity instanceof OpenAIAgentIdentity
    ? identity
    : new OpenAIAgentIdentity(identity);
}
