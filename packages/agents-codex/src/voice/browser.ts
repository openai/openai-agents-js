import {
  NativeVoiceControl,
  PortableVoiceSession,
  type PortableVoiceOptions,
} from './portable';

/** Exchange SDP with the application's authenticated native voice server.
 * Resolve only after the server's native control connection is ready.
 */
export type VoiceSdpExchange = (
  offerSdp: string,
  signal: AbortSignal,
) => Promise<string>;

export interface NativeVoiceWebRTCOptions {
  audioElement?: Pick<HTMLMediaElement, 'play' | 'srcObject'>;
  /** Platform-owned factories allow WebRTC integrations without global shims. */
  createPeerConnection?: () => RTCPeerConnection | Promise<RTCPeerConnection>;
  getUserMedia?: () => Promise<MediaStream>;
  onRemoteStream?: (stream: MediaStream) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  /** Supplied tracks remain owned by the application after close. */
  mediaStream?: MediaStream;
  /** Provider observations confer no native tool or approval authority. */
  onTransportEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}

/** Browser media only; the application server owns native voice control.
 * Each instance owns one connection attempt. Create a new instance after close.
 */
export class NativeVoiceWebRTC {
  readonly #abort = new AbortController();
  #status: 'new' | 'connecting' | 'connected' | 'disconnected' | 'closed' =
    'new';
  #peer: RTCPeerConnection | undefined;
  #channel: RTCDataChannel | undefined;
  #stream: MediaStream | undefined;
  #trackEnded: (() => void) | undefined;
  #playback: MediaStream | undefined;
  #disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly options: NativeVoiceWebRTCOptions;

  constructor(options: NativeVoiceWebRTCOptions) {
    this.options = { ...options };
  }

  get status() {
    return this.#status;
  }

  get muted(): boolean {
    return (
      this.#stream?.getAudioTracks().every((track) => !track.enabled) ?? false
    );
  }

  async connect(options: { exchangeSdp: VoiceSdpExchange }): Promise<void> {
    if (this.#status !== 'new')
      throw new Error('Create a new NativeVoiceWebRTC for each connection.');
    this.#status = 'connecting';
    const { signal } = this.#abort;
    const opening = this.#connect(options.exchangeSdp);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      await Promise.race([opening, aborted]);
    } catch (error) {
      try {
        this.close();
      } catch {
        /* Preserve the connection error. */
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #connect(exchange: VoiceSdpExchange): Promise<void> {
    const { signal } = this.#abort;
    const stream =
      this.options.mediaStream ??
      (await (this.options.getUserMedia?.() ??
        navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        })));
    if (signal.aborted) {
      if (!this.options.mediaStream)
        for (const track of stream.getTracks()) track.stop();
      signal.throwIfAborted();
    }
    this.#stream = stream;
    const tracks = stream.getAudioTracks();
    if (tracks.length !== 1 || tracks[0].readyState === 'ended')
      throw new Error('Voice media requires one live microphone audio track.');
    const peer = await (this.options.createPeerConnection?.() ??
      new RTCPeerConnection());
    if (signal.aborted) {
      peer.close();
      signal.throwIfAborted();
    }
    this.#peer = peer;
    const channel = peer.createDataChannel('oai-events');
    this.#channel = channel;
    const fail = (error: Error) => {
      if (signal.aborted) return;
      this.#abort.abort(error);
      try {
        this.close();
      } catch {
        /* Report the primary media error. */
      }
      this.options.onError?.(error);
    };
    this.#trackEnded = () => fail(new Error('Voice microphone ended.'));
    tracks[0].addEventListener('ended', this.#trackEnded);
    channel.onmessage = ({ data }) => {
      if (signal.aborted) return;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        fail(new Error('Voice data channel received invalid JSON.'));
        return;
      }
      this.options.onTransportEvent?.(event);
    };
    this.options.onDataChannel?.(channel);
    channel.onerror = () => fail(new Error('Voice data channel failed.'));
    channel.onclose = () => fail(new Error('Voice data channel closed.'));
    peer.ontrack = ({ streams }) => {
      if (signal.aborted || !streams[0]) return;
      this.#playback = streams[0];
      this.options.onRemoteStream?.(streams[0]);
      if (this.options.audioElement) {
        this.options.audioElement.srcObject = streams[0];
        void this.options.audioElement
          .play()
          .catch(() => fail(new Error('Voice audio playback failed.')));
      }
    };
    peer.onconnectionstatechange = () => {
      if (signal.aborted) return;
      if (peer.connectionState === 'disconnected') {
        this.#status = 'disconnected';
        this.#disconnectTimer ??= setTimeout(() => {
          this.#disconnectTimer = undefined;
          if (peer.connectionState === 'disconnected')
            fail(new Error('Voice peer disconnected.'));
        }, 10_000);
      } else {
        clearTimeout(this.#disconnectTimer);
        this.#disconnectTimer = undefined;
        if (
          peer.connectionState === 'failed' ||
          peer.connectionState === 'closed'
        )
          fail(new Error('Voice peer connection failed.'));
        else
          this.#status =
            peer.connectionState === 'connected' ? 'connected' : 'connecting';
      }
    };
    peer.addTrack(tracks[0], stream);
    const offer = await peer.createOffer();
    signal.throwIfAborted();
    await peer.setLocalDescription(offer);
    signal.throwIfAborted();
    const sdp = peer.localDescription?.sdp ?? offer.sdp;
    if (!sdp) throw new Error('The browser did not create a voice SDP offer.');
    const answer = await exchange(sdp, signal);
    signal.throwIfAborted();
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    signal.throwIfAborted();
    if (peer.connectionState === 'connected') this.#status = 'connected';
  }

  setMuted(muted: boolean): void {
    for (const track of this.#stream?.getAudioTracks() ?? [])
      track.enabled = !muted;
  }

  close(): void {
    if (this.#status === 'closed') return;
    this.#status = 'closed';
    this.#abort.abort(new Error('Voice media was closed.'));
    clearTimeout(this.#disconnectTimer);
    this.#disconnectTimer = undefined;
    const channel = this.#channel;
    const peer = this.#peer;
    const stream = this.#stream;
    this.#channel = undefined;
    this.#peer = undefined;
    this.#stream = undefined;
    let failure: unknown;
    const clean = (action: () => void) => {
      try {
        action();
      } catch (error) {
        failure ??= error;
      }
    };
    if (channel) {
      channel.onmessage =
        channel.onerror =
        channel.onclose =
        channel.onopen =
          null;
      clean(() => channel.close());
    }
    if (peer) {
      peer.ontrack = peer.onconnectionstatechange = null;
      clean(() => peer.close());
    }
    for (const track of stream?.getAudioTracks() ?? [])
      if (this.#trackEnded)
        track.removeEventListener('ended', this.#trackEnded);
    this.#trackEnded = undefined;
    if (!this.options.mediaStream)
      for (const track of stream?.getTracks() ?? []) clean(() => track.stop());
    if (
      this.#playback &&
      this.options.audioElement?.srcObject === this.#playback
    )
      this.options.audioElement.srcObject = null;
    this.#playback = undefined;
    if (failure !== undefined) throw failure;
  }
}

/** Browser-hosted Rust control over the provider's WebRTC data channel.
 * Supply a short-lived client credential and the reviewed native control module.
 */
export async function connectPortableVoiceBrowser(options: {
  control: NativeVoiceControl;
  apiKey: string;
  agent: PortableVoiceOptions;
  media: NativeVoiceWebRTCOptions;
  callUrl?: string;
  signal?: AbortSignal;
}): Promise<{ session: PortableVoiceSession; media: NativeVoiceWebRTC }> {
  options.signal?.throwIfAborted();
  const endpoint = new URL(
    options.callUrl ?? 'https://api.openai.com/v1/realtime/calls',
  );
  if (endpoint.protocol !== 'https:')
    throw new TypeError('Provider call URL must use https.');
  let channel: RTCDataChannel | undefined;
  let openResolve!: () => void;
  let openReject!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  void opened.catch(() => {});
  const session = new PortableVoiceSession(
    options.control,
    {
      async send(frame) {
        await opened;
        if (!channel || channel.readyState !== 'open')
          throw new Error('Voice data channel is not open.');
        channel.send(frame);
      },
      close() {
        openReject(new Error('Voice data channel closed.'));
        options.signal?.removeEventListener('abort', abort);
        media.close();
      },
    },
    options.agent,
  );
  const abort = () =>
    session.fail(
      options.signal?.reason ?? new Error('Voice connection aborted.'),
    );
  const media = new NativeVoiceWebRTC({
    ...options.media,
    onDataChannel(dataChannel) {
      channel = dataChannel;
      channel.onopen = () => openResolve();
      if (channel.readyState === 'open') openResolve();
      options.media.onDataChannel?.(channel);
    },
    onTransportEvent(event) {
      session.receive(event);
      options.media.onTransportEvent?.(event);
    },
    onError(error) {
      session.fail(error);
      options.media.onError?.(error);
    },
  });
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    await media.connect({
      exchangeSdp: async (offer, signal) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/sdp',
          },
          body: offer,
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Voice SDP exchange failed (${response.status}).`);
        }
        return response.text();
      },
    });
    await session.start();
    return { session, media };
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the opening error while releasing the acquired media.
    }
    throw error;
  }
}
