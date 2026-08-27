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
  readonly #onError: () => void;
  readonly #remoteAudio: Pick<HTMLAudioElement, 'play' | 'srcObject'>;
  readonly #getUserMedia: typeof navigator.mediaDevices.getUserMedia;
  readonly #createPeerConnection: () => RTCPeerConnection;

  #connectAbortController: AbortController | null = null;
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

  get connected(): boolean {
    return this.#peerConnection?.connectionState === 'connected';
  }

  get muted(): boolean {
    return (
      this.#localStream?.getAudioTracks().every((track) => !track.enabled) ??
      false
    );
  }

  async connect(exchangeSdp: SdpExchange): Promise<void> {
    if (this.#connectAbortController || this.#peerConnection) {
      throw new Error('The audio connection is already active or connecting.');
    }

    const abortController = new AbortController();
    this.#connectAbortController = abortController;
    try {
      const localStream = await this.#getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (!this.#ownsConnectAttempt(abortController)) {
        for (const track of localStream.getTracks()) {
          track.stop();
        }
        this.#throwConnectCancelled(abortController.signal);
      }
      this.#localStream = localStream;

      const audioTracks = localStream.getAudioTracks();
      if (audioTracks.length !== 1) {
        throw new Error('Expected exactly one microphone audio track.');
      }

      const peerConnection = this.#createPeerConnection();
      this.#peerConnection = peerConnection;
      peerConnection.onconnectionstatechange = () => {
        if (this.#peerConnection !== peerConnection) {
          return;
        }
        if (peerConnection.connectionState === 'disconnected') {
          this.#disconnectTimer ??= setTimeout(() => {
            this.#disconnectTimer = null;
            if (
              this.#peerConnection === peerConnection &&
              peerConnection.connectionState === 'disconnected'
            ) {
              this.close();
              this.#onError();
            }
          }, 10_000);
          return;
        }
        this.#clearDisconnectTimer();
        if (peerConnection.connectionState === 'failed') {
          this.close();
          this.#onError();
        }
      };
      peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream) {
          return;
        }
        this.#remoteAudio.srcObject = remoteStream;
        void this.#remoteAudio.play().catch(() => {});
      };

      peerConnection.addTrack(audioTracks[0]!, localStream);

      const offer = await peerConnection.createOffer();
      this.#throwIfConnectInactive(abortController);
      await peerConnection.setLocalDescription(offer);
      this.#throwIfConnectInactive(abortController);
      const offerSdp = peerConnection.localDescription?.sdp ?? offer.sdp;
      if (!offerSdp) {
        throw new Error('The browser did not create an SDP offer.');
      }

      const answerSdp = await exchangeSdp(offerSdp, abortController.signal);
      this.#throwIfConnectInactive(abortController);
      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });
      this.#throwIfConnectInactive(abortController);
    } catch (error) {
      if (this.#ownsConnectAttempt(abortController)) {
        this.close();
      }
      throw error;
    } finally {
      if (this.#ownsConnectAttempt(abortController)) {
        this.#connectAbortController = null;
      }
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.#localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  close(): void {
    this.#clearDisconnectTimer();
    const abortController = this.#connectAbortController;
    this.#connectAbortController = null;
    abortController?.abort(new Error('The audio connection was closed.'));

    const peerConnection = this.#peerConnection;
    this.#peerConnection = null;
    if (peerConnection) {
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.close();
    }

    for (const track of this.#localStream?.getTracks() ?? []) {
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

  #ownsConnectAttempt(abortController: AbortController): boolean {
    return this.#connectAbortController === abortController;
  }

  #throwIfConnectInactive(abortController: AbortController): void {
    if (
      !this.#ownsConnectAttempt(abortController) ||
      abortController.signal.aborted
    ) {
      this.#throwConnectCancelled(abortController.signal);
    }
  }

  #throwConnectCancelled(signal: AbortSignal): never {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('The audio connection was closed.');
  }
}
