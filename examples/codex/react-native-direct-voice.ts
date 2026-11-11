/** Direct native Realtime control in a React Native application, without a microphone.
 * The application has been owning its react-native-webrtc installation and transport.
 * The SDK's Hermes controller has been owning the session, tools and handoffs.
 *
 * import { RTCPeerConnection } from 'react-native-webrtc';
 * const call = await connectReactNativeDirectText({
 *   createPeerConnection: () => new RTCPeerConnection(),
 *   clientSecret: shortLivedClientSecretFromYourServer,
 *   agent: { model: 'gpt-realtime', instructions: 'Help the user.' },
 * });
 * call.sendText('Hello');
 * // Screen teardown: await call.close().
 *
 * The server has been issuing short-lived Realtime client secrets; the application
 * has been keeping long-lived API keys out of the client.
 * Matching development build: ./guides/building.md.
 * Application requirements: react-native-webrtc and standard AbortController,
 * EventTarget and fetch globals; microphone permissions and audio routing for voice.
 */
import {
  connectPortableVoiceReactNative,
  PortableVoiceSession,
  type NativeVoiceMediaStream,
  type NativeVoicePeerConnection,
  type PortableVoiceOptions,
} from '@openai/agents/voice/react-native';
import { createHermesVoiceControl } from '@openai/agents/voice/control.hermes';

/** Direct microphone route; app permission, audio routing and native module ownership. */
export async function connectReactNativeDirectVoice<
  Stream extends NativeVoiceMediaStream & { release(): void },
>(options: {
  createPeerConnection: () => NativeVoicePeerConnection;
  mediaDevices: {
    getUserMedia(constraints: { audio: true; video: false }): Promise<Stream>;
  };
  clientSecret: string;
  agent: PortableVoiceOptions;
  onRemoteStream: (stream: Stream) => void | Promise<void>;
  signal?: AbortSignal;
}) {
  if (options.signal?.aborted)
    throw options.signal.reason ?? new Error('Voice connection aborted.');
  const microphone = await options.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    options.signal?.removeEventListener('abort', release);
    try {
      for (const track of microphone.getTracks()) track.stop();
    } finally {
      microphone.release();
    }
  };
  options.signal?.addEventListener('abort', release, { once: true });
  const onError = options.agent.onError;
  try {
    const call = await connectPortableVoiceReactNative({
      control: createHermesVoiceControl(),
      apiKey: options.clientSecret,
      agent: {
        ...options.agent,
        onError(error) {
          try {
            release();
          } finally {
            onError?.(error);
          }
        },
      },
      signal: options.signal,
      media: {
        mediaStream: microphone,
        createPeerConnection: options.createPeerConnection,
        onRemoteStream: options.onRemoteStream,
        onError: release,
      },
    });
    return {
      ...call,
      async close() {
        try {
          await call.session.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

interface TextDataChannel {
  readonly readyState: string;
  send(frame: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: { data?: unknown }) => void,
  ): void;
}

interface TextPeerConnection extends NativeVoicePeerConnection {
  createDataChannel(label: string): TextDataChannel;
  addTransceiver(kind: 'audio', options: { direction: 'inactive' }): unknown;
}

export async function connectReactNativeDirectText(options: {
  createPeerConnection: () => TextPeerConnection;
  clientSecret: string;
  agent: PortableVoiceOptions;
  signal?: AbortSignal;
}): Promise<PortableVoiceSession> {
  if (options.signal?.aborted)
    throw options.signal.reason ?? new Error('Voice connection aborted.');
  const { clientSecret } = options;
  if (
    typeof clientSecret !== 'string' ||
    !/^ek_[\x21-\x7e]+$/.test(clientSecret)
  )
    throw new TypeError(
      'React Native direct text requires an ephemeral client key.',
    );
  const connection = new AbortController();
  let peer: TextPeerConnection | undefined;
  let channel: TextDataChannel | undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  void opened.catch(() => {});

  const session = new PortableVoiceSession(
    createHermesVoiceControl(),
    {
      async send(frame) {
        await opened;
        if (!channel || channel.readyState !== 'open')
          throw new Error('Voice data channel is not open.');
        channel.send(frame);
      },
      close() {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        connection.abort();
        rejectOpen(new Error('Voice data channel closed.'));
        options.signal?.removeEventListener('abort', aborted);
        channel?.removeEventListener('open', resolveOpen);
        channel?.removeEventListener('message', message);
        channel?.removeEventListener('error', failed);
        channel?.removeEventListener('close', failed);
        try {
          channel?.close();
        } finally {
          peer?.close();
        }
      },
    },
    {
      ...options.agent,
      settings: { ...options.agent.settings, output_modalities: ['text'] },
    },
  );
  const aborted = () =>
    session.fail(
      options.signal?.reason ?? new Error('Voice connection aborted.'),
    );
  const failed = () => session.fail(new Error('Voice data channel closed.'));
  const message = (event: { data?: unknown }) => {
    if (typeof event.data !== 'string') {
      session.fail(new Error('Voice provider frame is not text.'));
      return;
    }
    try {
      session.receive(JSON.parse(event.data));
    } catch (error) {
      session.fail(error);
    }
  };

  try {
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) {
      aborted();
      throw options.signal.reason ?? new Error('Voice connection aborted.');
    }
    timer = setTimeout(
      () => session.fail(new Error('Voice connection timed out.')),
      10_000,
    );
    peer = options.createPeerConnection();
    if (disposed) {
      peer.close();
      throw new Error('Voice connection aborted.');
    }
    channel = peer.createDataChannel('oai-events');
    if (disposed) {
      channel.close();
      throw new Error('Voice connection aborted.');
    }
    channel.addEventListener('open', resolveOpen);
    channel.addEventListener('message', message);
    channel.addEventListener('error', failed);
    channel.addEventListener('close', failed);
    if (channel.readyState === 'open') resolveOpen();
    // The inactive audio section has been preserving v0's no-microphone SDP route.
    peer.addTransceiver('audio', { direction: 'inactive' });
    const offer = await peer.createOffer();
    if (!offer.sdp) throw new Error('Voice offer has no SDP.');
    await peer.setLocalDescription({ ...offer, sdp: offer.sdp });
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      signal: connection.signal,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offer.sdp,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Voice SDP exchange failed (${response.status})`);
    }
    await peer.setRemoteDescription({
      type: 'answer',
      sdp: await response.text(),
    });
    await opened;
    await session.start();
    clearTimeout(timer);
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}
