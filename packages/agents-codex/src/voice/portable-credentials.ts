/** One per-connection credential value or resolver, without ambient credential lookup. */
export type PortableVoiceApiKey =
  string | ((signal?: AbortSignal) => string | Promise<string>);

/** Resolve once before acquiring transport/media, retiring the wait on cancellation. */
export async function resolvePortableVoiceApiKey(
  credential: PortableVoiceApiKey,
  signal?: AbortSignal,
): Promise<string> {
  const checkAbort = () => {
    if (signal?.aborted)
      throw signal.reason ?? new Error('Voice connection aborted.');
  };
  checkAbort();
  const resolving = Promise.resolve().then(() => {
    checkAbort();
    return typeof credential === 'function' ? credential(signal) : credential;
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal) {
      onAbort = () =>
        reject(signal.reason ?? new Error('Voice connection aborted.'));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
  try {
    const value = await Promise.race([resolving, aborted]);
    checkAbort();
    return value;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
