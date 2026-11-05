/** Explicit personal ChatGPT credentials, separate from Model API credentials. */
export interface ChatGPTAuth {
  readonly accountId: string;
  readonly accessToken: string;
}

/** @internal Capture credentials once, before opening native resources. */
export function captureChatGPTAuth(
  value: ChatGPTAuth | undefined,
): Readonly<ChatGPTAuth> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object')
    throw new TypeError(
      'ChatGPT credentials require accountId and accessToken',
    );
  const { accountId, accessToken } = value;
  if (typeof accessToken !== 'string' || !/^[\x21-\x7e]+$/.test(accessToken))
    throw new TypeError(
      'ChatGPT accessToken must contain visible ASCII characters',
    );
  if (
    typeof accountId !== 'string' ||
    !accountId ||
    Buffer.byteLength(accountId, 'utf8') > 1024 ||
    Buffer.from(accountId, 'utf8').toString('utf8') !== accountId ||
    accountId.trim() !== accountId ||
    [...accountId].some(
      (character) =>
        character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    )
  )
    throw new TypeError('Invalid ChatGPT accountId');
  // Credentials stay out of ordinary object serialization and inspection.
  return Object.freeze(
    Object.defineProperties(Object.create(null), {
      accountId: { value: accountId },
      accessToken: { value: accessToken },
    }) as ChatGPTAuth,
  );
}
