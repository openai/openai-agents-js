import type { ManualToolRequest } from './manual';
import type { JsonObject } from './binding';
import type { PreparedNativeForm } from './native-forms';
import type { NativeUrlCompletionOptions } from './url-elicitation';
import type { UserVerificationRequest } from './verification';

export type { NativeUrlCompletionOptions } from './url-elicitation';

declare const nativeReply: unique symbol;

/**
 * A one-use reply to an issued native request. Delivery rejects expired authority
 * and does not confirm an external effect.
 */
export interface NativeQuestionReply {
  readonly [nativeReply]: true;
}

interface QuestionIdentity {
  readonly sessionId: string;
  readonly subagentId: string | null;
  readonly submissionId: string | null;
  readonly turnId: string | null;
  readonly description: string;
  readonly call: null;
}

/** A one-time decision for an explicitly owned native approval. */
export interface ApprovalRequest extends QuestionIdentity {
  readonly type: 'approval_request';
  readonly submissionId: string;
  readonly turnId: string;
  reply(decision: 'allow_once' | 'deny'): NativeQuestionReply;
}

/**
 * An issued form or URL request. The SDK never visits the URL or retries a tool
 * because a peer reports completion.
 */
export interface ElicitationRequest extends QuestionIdentity {
  readonly type: 'elicitation_request';
  readonly mode: 'form' | 'url';
  readonly schema: Readonly<Record<string, unknown>>;
  readonly url: string | null;
  readonly elicitationId: string | null;
  readonly serverName: string | null;
  /** Forms accept values or null; URL requests retain null-only decline here. */
  reply(values: Readonly<JsonObject> | null): NativeQuestionReply;
  /** Prepare URL consent. Only Session.respond delivers it to the issuing peer. */
  replyUrlAccept(): NativeQuestionReply;
  /**
   * Observe matched peer completion, even after the original root turn ends.
   * A deadline retires this URL lifecycle and joins its native cancellation.
   * Aborting signal cancels only this observer. Completion is a peer report,
   * not proof of authorization or cryptographic verification.
   */
  waitForCompletion(options: NativeUrlCompletionOptions): Promise<void>;
}

export type NativeQuestion =
  ApprovalRequest | ElicitationRequest | UserVerificationRequest;
export type Interaction = ManualToolRequest | NativeQuestion;

/** @internal Only Session may issue and deliver a live request. */
export interface NativeQuestionGrant {
  readonly request: NativeQuestion;
  current(): boolean;
  take(reply: NativeQuestionReply): string;
  deactivate(): void;
}

const replies = new WeakMap<
  object,
  { request: NativeQuestion; wire: string }
>();

const urlConsent = Symbol('URL consent');

/** @internal Runs after immutable identity/reply installation, before freeze. */
export type NativeQuestionPresentation = (
  target: object,
  prepareReply: (value: unknown) => NativeQuestionReply,
) => void;

/** @internal A cast or deserialized object cannot issue a reply. */
export function isNativeQuestionReply(
  value: unknown,
): value is NativeQuestionReply {
  return typeof value === 'object' && value !== null && replies.has(value);
}

/** @internal Session checks its own live record before consumption. */
export function nativeReplyRequest(
  reply: NativeQuestionReply,
): NativeQuestion | undefined {
  return replies.get(reply)?.request;
}

/** @internal Preserve exact IDs and untrusted schema data before event normalization. */
export function parseNativeQuestion(raw: string): {
  id: string;
  schema: unknown;
} {
  const tokens = new WeakMap<object, string>();
  const parsed: unknown = JSON.parse(
    raw,
    function (
      this: object,
      key: string,
      value: unknown,
      context?: { source?: string },
    ) {
      if (key === 'id' && typeof value === 'number')
        tokens.set(this, context?.source ?? '');
      return value;
    },
  );
  if (!parsed || typeof parsed !== 'object' || !('msg' in parsed))
    throw new TypeError('Missing native question identity');
  const message = parsed.msg;
  if (!message || typeof message !== 'object' || !('id' in message))
    throw new TypeError('Missing native question identity');
  let id: string;
  if (typeof message.id === 'string') id = JSON.stringify(message.id);
  else {
    const token = tokens.get(message);
    if (!token || !/^-?(0|[1-9][0-9]*)$/.test(token))
      throw new TypeError('Native question requires exact JSON source access');
    const integer = BigInt(token);
    if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n)
      throw new TypeError(
        'Native question ID exceeds its native integer range',
      );
    id = token;
  }
  const request = 'request' in message ? message.request : undefined;
  const schema =
    request && typeof request === 'object' && 'requested_schema' in request
      ? request.requested_schema
      : undefined;
  return { id, schema };
}

/** @internal Descriptions and schema values are deliberately non-enumerable. */
export function issueNativeQuestion(
  identity: QuestionIdentity & { type: NativeQuestion['type'] },
  encode: (value: unknown) => string,
  live: () => boolean,
  form?: PreparedNativeForm,
  present?: NativeQuestionPresentation,
): NativeQuestionGrant {
  let current: (() => boolean) | undefined = live;
  const active = () => current?.() === true;
  const request = Object.create(null) as NativeQuestion;
  for (const key of [
    'type',
    'sessionId',
    'subagentId',
    'submissionId',
    'turnId',
    'call',
  ] as const)
    Object.defineProperty(request, key, {
      enumerable: true,
      value: identity[key],
    });
  Object.defineProperty(request, 'description', {
    value: identity.description,
  });
  if (identity.type === 'elicitation_request')
    Object.defineProperty(request, 'schema', { get: () => form?.schema ?? {} });
  Object.defineProperty(request, Symbol.for('nodejs.util.inspect.custom'), {
    value: () =>
      `${identity.type} { sessionId: ${JSON.stringify(identity.sessionId)} }`,
  });
  const prepareReply = (value: unknown): NativeQuestionReply => {
    if (!active())
      throw new TypeError('Native request is expired or already answered');
    const wire = encode(value);
    const reply = Object.freeze(Object.create(null)) as NativeQuestionReply;
    replies.set(reply, { request, wire });
    return reply;
  };
  Object.defineProperty(request, 'reply', { value: prepareReply });
  if (present) present(request, prepareReply);
  else if (identity.type === 'elicitation_request')
    Object.defineProperties(request, {
      mode: { enumerable: true, value: 'form' },
      url: { value: null },
      elicitationId: { value: null },
      serverName: { value: null },
      replyUrlAccept: {
        value: () => {
          throw new TypeError('This form does not support URL consent');
        },
      },
      waitForCompletion: {
        value: () =>
          Promise.reject(new TypeError('This form has no URL completion')),
      },
    });
  Object.freeze(request);
  return {
    request,
    current: active,
    deactivate() {
      current = undefined;
    },
    take(reply) {
      const selected = replies.get(reply);
      if (!active() || selected?.request !== request)
        throw new TypeError(
          'Native reply is foreign, expired, or already delivered',
        );
      current = undefined;
      return selected.wire;
    },
  };
}

/** @internal Positive URL consent has no form content or proof payload. */
export function urlQuestionReply(
  fields: Readonly<Record<string, string>>,
  exactId: string,
): (value: unknown) => string {
  const captured = { ...fields };
  return (value) => {
    if (value !== null && value !== urlConsent)
      throw new TypeError(
        'Use replyUrlAccept() or reply(null) for a URL request',
      );
    return JSON.stringify({
      ...captured,
      kind: value === null ? 'decline_elicitation' : 'accept_url_elicitation',
      request_id: JSON.rawJSON(exactId),
    });
  };
}

/** @internal URL presentation shares the issuer's existing reply authority. */
export function urlQuestionPresentation(
  fields: { url: string; elicitationId: string; serverName: string },
  wait: (options: NativeUrlCompletionOptions) => Promise<void>,
): NativeQuestionPresentation {
  const captured = { ...fields };
  return (target, prepareReply) => {
    Object.defineProperties(target, {
      mode: { enumerable: true, value: 'url' },
      url: { value: captured.url },
      elicitationId: { value: captured.elicitationId },
      serverName: { value: captured.serverName },
      replyUrlAccept: { value: () => prepareReply(urlConsent) },
      waitForCompletion: { value: wait },
    });
  };
}

// Keep response encoders outside Session's scope. A retained expired wrapper
// keeps only its detached description and wire values, not a native owner.
/** @internal */
export function approvalQuestionReply(
  fields: Readonly<Record<string, string>>,
): (value: unknown) => string {
  const captured = { ...fields };
  return (value) => {
    if (value !== 'allow_once' && value !== 'deny')
      throw new TypeError('Use allow_once or deny');
    return JSON.stringify({ ...captured, decision: value });
  };
}

/** @internal */
export function negativeQuestionReply(
  wire: string,
): (value: unknown) => string {
  return (value) => {
    if (value !== null)
      throw new TypeError('URL verification supports decline only');
    return wire;
  };
}

/** @internal The form and ID token have already passed native request admission. */
export function formQuestionReply(
  serverName: string,
  exactRequestIdToken: string,
  preparedForm: PreparedNativeForm,
): (value: unknown) => string {
  const identity = {
    server_name: serverName,
    request_id: JSON.rawJSON(exactRequestIdToken),
  };
  return (value) => {
    if (value === null)
      return JSON.stringify({ kind: 'decline_elicitation', ...identity });
    const content = preparedForm.validate(value);
    return JSON.stringify({ kind: 'accept_elicitation', ...identity, content });
  };
}
