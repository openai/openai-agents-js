import WebSocket, { type RawData } from 'ws';
import { createDelegationHandler, type LiveMessage } from './delegation';
import { closeSocket, readMessage, sendMessage } from './transport';

/** Own the sideband, browser controls and serial specialist work until finalization. */
export async function relay(
  live: WebSocket,
  browser: WebSocket,
  runAgent: (request: string, signal: AbortSignal) => Promise<string>,
  answer: LiveMessage,
  setupSignal?: AbortSignal,
): Promise<boolean> {
  const stopped = Promise.withResolvers<void>();
  const finalized = Promise.withResolvers<void>();
  const transportClosed = Promise.withResolvers<void>();
  const cancellation = new AbortController();
  let stopping = false;
  let confirmed = false;
  let browserConnected = browser.readyState === WebSocket.OPEN;
  let notices = Promise.resolve();
  // A transport event can arrive while the initial browser answer is still flushing.
  void stopped.promise.catch(() => {});

  const notify = (message: LiveMessage) => {
    notices = notices.then(async () => {
      if (!browserConnected) return;
      try {
        await sendMessage(browser, message);
      } catch {
        browserConnected = false;
        stopped.resolve();
      }
    });
    return notices;
  };
  const handler = createDelegationHandler({
    signal: cancellation.signal,
    runAgent,
    notify,
    async send(message) {
      if (stopping) throw new Error('The Live session is closing.');
      await sendMessage(live, message);
    },
  });

  const onLiveMessage = (data: RawData) => {
    try {
      const message = readMessage(data);
      if (message.type === 'session.closed') {
        if (confirmed) return;
        confirmed = true;
        stopping = true;
        void notify({
          type: 'closed',
          usage: message.usage,
          reason: message.reason,
        });
        finalized.resolve();
        stopped.resolve();
      } else if (message.type === 'error') {
        stopping = true;
        stopped.reject(
          new Error('Live rejected a command or reported an error.'),
        );
      } else if (!stopping) {
        const work = handler.receive(message);
        if (work) void work.catch(stopped.reject);
        if (
          message.type === 'session.input_transcript.delta' ||
          message.type === 'session.output_transcript.delta' ||
          message.type === 'session.usage.updated'
        ) {
          void notify(message);
        }
      }
    } catch (error) {
      stopping = true;
      stopped.reject(error);
    }
  };
  const onLiveError = () => {
    stopping = true;
    stopped.reject(new Error('The Live connection failed.'));
  };
  const onLiveClose = () => {
    stopping = true;
    transportClosed.resolve();
    stopped.resolve();
  };
  const onBrowserMessage = (data: RawData) => {
    try {
      if (readMessage(data).type !== 'close')
        throw new Error('Unsupported browser command.');
      stopping = true;
      stopped.resolve();
    } catch (error) {
      stopping = true;
      stopped.reject(error);
    }
  };
  const onBrowserClose = () => {
    browserConnected = false;
    stopping = true;
    stopped.resolve();
  };
  const onSetupAbort = () => {
    stopping = true;
    stopped.resolve();
  };

  live.on('message', onLiveMessage);
  live.on('error', onLiveError);
  live.on('close', onLiveClose);
  browser.on('message', onBrowserMessage);
  browser.on('error', onBrowserClose);
  browser.on('close', onBrowserClose);
  setupSignal?.addEventListener('abort', onSetupAbort, { once: true });
  if (setupSignal?.aborted) onSetupAbort();
  try {
    if (!stopping) await notify(answer);
    if (!browserConnected || live.readyState !== WebSocket.OPEN)
      stopped.resolve();
    await stopped.promise;
  } finally {
    stopping = true;
    cancellation.abort(new Error('The Live conversation ended.'));
    // A delegate must settle its owned callbacks before its promise settles.
    await handler.drain().catch(() => {});
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!confirmed && live.readyState === WebSocket.OPEN) {
        const timeout = new Promise<never>((_, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error('Live finalization timed out.')),
            15_000,
          );
        });
        live.send(JSON.stringify({ type: 'session.close' }));
        await Promise.race([
          finalized.promise,
          transportClosed.promise,
          timeout,
        ]);
      }
    } catch {
      // A failed close command or missing final event leaves final usage unconfirmed.
    } finally {
      clearTimeout(closeTimer);
      if (!confirmed)
        await notify({
          type: 'error',
          message: 'Session finalization could not be confirmed.',
        });
      live.off('message', onLiveMessage);
      await notices;
      await closeSocket(live);
      live.off('error', onLiveError);
      live.off('close', onLiveClose);
      browser.off('message', onBrowserMessage);
      browser.off('error', onBrowserClose);
      browser.off('close', onBrowserClose);
      setupSignal?.removeEventListener('abort', onSetupAbort);
    }
  }
  return confirmed;
}
