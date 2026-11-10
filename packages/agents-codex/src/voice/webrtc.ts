/** Client media primitives shared by browser and app-owned mobile WebRTC. */
export type VoiceSdpExchange = (
  offerSdp: string,
  signal: AbortSignal,
) => Promise<string>;
export interface NativeVoiceMediaTrack {
  enabled: boolean;
  readonly readyState: string;
  stop(): void;
}
export interface NativeVoiceMediaStream {
  getAudioTracks(): NativeVoiceMediaTrack[];
  getTracks(): NativeVoiceMediaTrack[];
}
export interface NativeVoiceDataChannel {
  close(): void;
}
/** The methods used by the media owner; platform event types stay in the bridge. */
export interface NativeVoicePeerConnection {
  readonly localDescription: { readonly sdp?: string } | null;
  readonly connectionState: string;
  createDataChannel(label: string): NativeVoiceDataChannel;
  addTrack(
    track: NativeVoiceMediaTrack,
    stream: NativeVoiceMediaStream,
  ): unknown;
  createOffer(): Promise<{
    type: 'offer' | 'answer' | 'pranswer' | 'rollback';
    sdp?: string;
  }>;
  setLocalDescription(description: {
    type: 'offer' | 'answer' | 'pranswer' | 'rollback';
    sdp: string;
  }): Promise<void>;
  setRemoteDescription(description: {
    type: 'offer' | 'answer' | 'pranswer' | 'rollback';
    sdp: string;
  }): Promise<void>;
  close(): void;
}
interface NativeVoiceMediaOptions<Stream extends NativeVoiceMediaStream> {
  mediaStream?: Stream;
  acquireMedia?: () => Promise<Stream>;
  createPeerConnection: () => NativeVoicePeerConnection;
  play(stream: Stream): void | Promise<void>;
  clear?(stream: Stream): void;
  onTransportEvent?: (event: unknown) => void;
  onError?: (error: Error) => void;
}
// Mobile bindings implement these event APIs without always exposing their
// inherited declarations. Keep platform event adaptation in this one bridge.
function trackEvents(track: NativeVoiceMediaTrack) {
  return track as NativeVoiceMediaTrack & {
    addEventListener(type: 'ended', listener: () => void): void;
    removeEventListener(type: 'ended', listener: () => void): void;
  };
}
function channelEvents(channel: NativeVoiceDataChannel) {
  return channel as NativeVoiceDataChannel & {
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
    onclose: (() => void) | null;
  };
}
function peerEvents<Stream>(peer: NativeVoicePeerConnection) {
  return peer as NativeVoicePeerConnection & {
    ontrack: ((event: { streams: Stream[] }) => void) | null;
    onconnectionstatechange: (() => void) | null;
  };
}

export class NativeVoiceMedia<Stream extends NativeVoiceMediaStream> {
  readonly #abort = new AbortController();
  #abortReason: Error | undefined;
  #status: 'new' | 'connecting' | 'connected' | 'disconnected' | 'closed' =
    'new';
  #peer: NativeVoicePeerConnection | undefined;
  #channel: NativeVoiceDataChannel | undefined;
  #stream: Stream | undefined;
  #trackEnded: (() => void) | undefined;
  #playback: Stream | undefined;
  #disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly options: NativeVoiceMediaOptions<Stream>;

  constructor(options: NativeVoiceMediaOptions<Stream>) {
    this.options = { ...options };
  }

  private abort(reason: Error): void {
    if (this.#abort.signal.aborted) return;
    this.#abortReason = reason;
    // Older React Native controllers ignore the reason argument and omit reason.
    this.#abort.abort(reason);
  }

  private throwIfAborted(): void {
    if (this.#abort.signal.aborted)
      throw this.#abortReason ?? new Error('Voice media was closed.');
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
      onAbort = () =>
        reject(this.#abortReason ?? new Error('Voice media was closed.'));
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
      this.options.mediaStream ?? (await this.options.acquireMedia!());
    if (signal.aborted) {
      if (!this.options.mediaStream)
        for (const track of stream.getTracks()) track.stop();
      this.throwIfAborted();
    }
    this.#stream = stream;
    const tracks = stream.getAudioTracks();
    if (tracks.length !== 1 || tracks[0].readyState === 'ended')
      throw new Error('Voice media requires one live microphone audio track.');
    const peer = this.options.createPeerConnection();
    this.#peer = peer;
    const channel = channelEvents(peer.createDataChannel('oai-events'));
    this.#channel = channel;
    const fail = (error: Error) => {
      if (signal.aborted) return;
      this.abort(error);
      try {
        this.close();
      } catch {
        /* Report the primary media error. */
      }
      this.options.onError?.(error);
    };
    this.#trackEnded = () => fail(new Error('Voice microphone ended.'));
    trackEvents(tracks[0]).addEventListener('ended', this.#trackEnded);
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
    channel.onerror = () => fail(new Error('Voice data channel failed.'));
    channel.onclose = () => fail(new Error('Voice data channel closed.'));
    const callbacks = peerEvents<Stream>(peer);
    callbacks.ontrack = ({ streams }) => {
      if (signal.aborted || !streams[0]) return;
      this.#playback = streams[0];
      try {
        void Promise.resolve(this.options.play(streams[0])).catch(() =>
          fail(new Error('Voice audio playback failed.')),
        );
      } catch {
        fail(new Error('Voice audio playback failed.'));
      }
    };
    callbacks.onconnectionstatechange = () => {
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
    this.throwIfAborted();
    if (!offer.sdp)
      throw new Error('The peer did not create a voice SDP offer.');
    await peer.setLocalDescription({ ...offer, sdp: offer.sdp });
    this.throwIfAborted();
    const sdp = peer.localDescription?.sdp ?? offer.sdp;
    if (!sdp) throw new Error('The browser did not create a voice SDP offer.');
    const answer = await exchange(sdp, signal);
    this.throwIfAborted();
    await peer.setRemoteDescription({ type: 'answer', sdp: answer });
    this.throwIfAborted();
    if (peer.connectionState === 'connected') this.#status = 'connected';
  }

  setMuted(muted: boolean): void {
    for (const track of this.#stream?.getAudioTracks() ?? [])
      track.enabled = !muted;
  }

  close(): void {
    if (this.#status === 'closed') return;
    this.#status = 'closed';
    this.abort(new Error('Voice media was closed.'));
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
      const callbacks = channelEvents(channel);
      callbacks.onmessage = callbacks.onerror = callbacks.onclose = null;
      clean(() => channel.close());
    }
    if (peer) {
      const callbacks = peerEvents<Stream>(peer);
      callbacks.ontrack = callbacks.onconnectionstatechange = null;
      clean(() => peer.close());
    }
    for (const track of stream?.getAudioTracks() ?? [])
      if (this.#trackEnded)
        trackEvents(track).removeEventListener('ended', this.#trackEnded);
    this.#trackEnded = undefined;
    if (!this.options.mediaStream)
      for (const track of stream?.getTracks() ?? []) clean(() => track.stop());
    if (this.#playback) clean(() => this.options.clear?.(this.#playback!));
    this.#playback = undefined;
    if (failure !== undefined) throw failure;
  }
}
