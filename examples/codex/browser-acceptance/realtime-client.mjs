/* global AudioContext, document, fetch, RTCPeerConnection, setTimeout, window */
import { NativeVoiceWebRTC } from '/sdk/voice/browser.mjs';

// This local synthetic provider uses a real second browser peer. The native
// server still owns call creation, the SDP answer, the sideband, and hangup.
async function run() {
  const audio = document.querySelector('audio');
  const media = new NativeVoiceWebRTC({ audioElement: audio });
  const providerPeer = new RTCPeerConnection();
  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  providerPeer.addTrack(
    destination.stream.getAudioTracks()[0],
    destination.stream,
  );
  let microphoneTrack;
  providerPeer.ontrack = ({ track }) => {
    microphoneTrack = track;
  };
  providerPeer.ondatachannel = ({ channel }) => {
    channel.onopen = () =>
      channel.send(JSON.stringify({ type: 'synthetic.browser.ready' }));
  };
  async function until(check) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Browser media did not reach the expected state');
  }
  try {
    await audioContext.resume();
    await media.connect({
      exchangeSdp: async (offerSdp, signal) => {
        await providerPeer.setRemoteDescription({
          type: 'offer',
          sdp: offerSdp,
        });
        await providerPeer.setLocalDescription(
          await providerPeer.createAnswer(),
        );
        if (providerPeer.iceGatheringState !== 'complete') {
          await until(() => providerPeer.iceGatheringState === 'complete');
        }
        const response = await fetch('/exchange', {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            offerSdp,
            answerSdp: providerPeer.localDescription.sdp,
          }),
        });
        if (!response.ok) throw new Error('Native call exchange failed');
        const accepted = await response.json();
        return accepted.answerSdp;
      },
    });
    await until(
      () =>
        media.status === 'connected' && microphoneTrack?.readyState === 'live',
    );
    let microphoneBytes = 0;
    await until(async () => {
      const stats = await providerPeer.getStats();
      microphoneBytes = [...stats.values()]
        .filter(
          (entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio',
        )
        .reduce((total, entry) => total + entry.bytesReceived, 0);
      return microphoneBytes > 0;
    });
    await until(
      () =>
        !audio.paused &&
        audio.currentTime > 0 &&
        audio.srcObject?.getAudioTracks().length === 1,
    );
    const playbackTime = audio.currentTime;
    await until(() => audio.currentTime > playbackTime);
    const playedThrough = audio.currentTime;
    media.setMuted(true);
    if (!media.muted) throw new Error('Microphone mute failed');
    media.setMuted(false);
    if (media.muted) throw new Error('Microphone unmute failed');
    await fetch('/close', { method: 'POST' }).then((response) => {
      if (!response.ok) throw new Error('Native call cleanup failed');
    });
    media.close();
    if (media.status !== 'closed' || audio.srcObject !== null)
      throw new Error('Browser media cleanup failed');
    return {
      microphoneBytes,
      playbackTime: playedThrough,
      mutedAndRestored: true,
      closed: true,
    };
  } finally {
    media.close();
    providerPeer.close();
    oscillator.stop();
    await audioContext.close();
  }
}

document.querySelector('button').onclick = () => {
  window.acceptance = run().then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: String(error) }),
  );
};
