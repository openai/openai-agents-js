export type SdpExchange = (
  offerSdp: string,
  signal: AbortSignal,
) => Promise<string>;

export type AudioOnlyWebRtcOptions = {
  onError(): void;
  remoteAudio: Pick<HTMLAudioElement, 'play' | 'srcObject'>;
  getUserMedia?: typeof navigator.mediaDevices.getUserMedia;
  createPeerConnection?: () => RTCPeerConnection;
};

export class AudioOnlyWebRtc {
  readonly #abortController = new AbortController();
  readonly #onError: () => void;
  readonly #remoteAudio: Pick<HTMLAudioElement, 'play' | 'srcObject'>;
  readonly #getUserMedia: typeof navigator.mediaDevices.getUserMedia;
  readonly #createPeerConnection: () => RTCPeerConnection;

  #started = false;
  #peerConnection: RTCPeerConnection | null = null;
  #localStream: MediaStream | null = null;
  #disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AudioOnlyWebRtcOptions) {
    this.#onError = options.onError;
    this.#remoteAudio = options.remoteAudio;
    this.#getUserMedia =
      options.getUserMedia ??
      ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
    this.#createPeerConnection =
      options.createPeerConnection ?? (() => new RTCPeerConnection());
  }

  get muted(): boolean {
    return (
      this.#localStream?.getAudioTracks().every((track) => !track.enabled) ??
      false
    );
  }

  async connect(exchangeSdp: SdpExchange): Promise<void> {
    if (this.#started) {
      throw new Error('Create a new audio connection for each voice session.');
    }
    const { signal } = this.#abortController;
    signal.throwIfAborted();
    this.#started = true;
    try {
      const localStream = await this.#getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (signal.aborted) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        signal.throwIfAborted();
      }
      this.#localStream = localStream;

      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length !== 1) {
        throw new Error('Expected exactly one microphone audio track.');
      }
      const audioTrack = audioTracks[0]!;
      if (audioTrack.readyState === 'ended') {
        throw new Error('The microphone is no longer available.');
      }

      const fail = () => {
        if (!signal.aborted) {
          this.close();
          this.#onError();
        }
      };
      audioTrack.onended = fail;

      const peerConnection = this.#createPeerConnection();
      this.#peerConnection = peerConnection;
      peerConnection.onconnectionstatechange = () => {
        if (signal.aborted) {
          return;
        }
        if (peerConnection.connectionState === 'disconnected') {
          this.#disconnectTimer ??= setTimeout(() => {
            this.#disconnectTimer = null;
            if (peerConnection.connectionState === 'disconnected') {
              fail();
            }
          }, 10_000);
          return;
        }
        this.#clearDisconnectTimer();
        if (peerConnection.connectionState === 'failed') {
          fail();
        }
      };
      peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (signal.aborted || !remoteStream) {
          return;
        }
        this.#remoteAudio.srcObject = remoteStream;
        void this.#remoteAudio.play().catch(fail);
      };

      peerConnection.addTrack(audioTrack, localStream);

      const offer = await peerConnection.createOffer();
      signal.throwIfAborted();
      await peerConnection.setLocalDescription(offer);
      signal.throwIfAborted();
      const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
      if (!offerSdp) {
        throw new Error('The browser did not create an SDP offer.');
      }

      const answerSdp = await exchangeSdp(offerSdp, signal);
      signal.throwIfAborted();
      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });
      signal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted) {
        this.close();
      }
      throw error;
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.#localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  close(): void {
    if (this.#abortController.signal.aborted) {
      return;
    }
    this.#abortController.abort(new Error('The audio connection was closed.'));
    this.#clearDisconnectTimer();

    const peerConnection = this.#peerConnection;
    this.#peerConnection = null;
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }

    for (const track of this.#localStream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.#localStream = null;
    this.#remoteAudio.srcObject = null;
  }

  #clearDisconnectTimer(): void {
    if (this.#disconnectTimer !== null) {
      clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = null;
    }
  }
}
