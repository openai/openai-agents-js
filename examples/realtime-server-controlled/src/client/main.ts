import './style.css';
import { AudioOnlyWebRtc } from './audioOnlyWebRtc';
import { requestCsrfToken } from './demoAuthClient';
import {
  VoiceSessionCoordinator,
  type VoiceSessionStatus,
} from './voiceSessionCoordinator';

const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const muteButton = document.querySelector<HTMLButtonElement>('#mute')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!;
const remoteAudio = document.querySelector<HTMLAudioElement>('#remote-audio')!;
const orb = document.querySelector<HTMLElement>('#orb')!;
const statusTitle = document.querySelector<HTMLElement>('#status-title')!;
const statusDetail = document.querySelector<HTMLElement>('#status-detail')!;

const statusCopy: Record<
  VoiceSessionStatus,
  { title: string; detail: string }
> = {
  ready: { title: 'Ready', detail: 'Start a session and speak naturally.' },
  connecting: {
    title: 'Connecting securely',
    detail: 'Preparing the audio path and server control channel.',
  },
  idle: { title: 'Listening', detail: 'The voice session is ready.' },
  listening: { title: 'Listening', detail: 'Keep speaking naturally.' },
  thinking: { title: 'Thinking', detail: 'Preparing a response.' },
  speaking: { title: 'Speaking', detail: 'You can interrupt at any time.' },
  error: {
    title: 'Session error',
    detail: 'End the session and try again.',
  },
};

function setStatus(state: keyof typeof statusCopy) {
  const copy = statusCopy[state];
  orb.dataset.state = state;
  statusTitle.textContent = copy.title;
  statusDetail.textContent = copy.detail;
}

const coordinator = new VoiceSessionCoordinator({
  getCsrfToken: requestCsrfToken,
  createConnection: () => new AudioOnlyWebRtc({ remoteAudio }),
  async exchangeOffer({ offerSdp, sessionId, signal, token }) {
    const response = await fetch('/api/realtime/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/sdp',
        'X-App-Session-Id': sessionId,
        'X-CSRF-Token': token,
      },
      body: offerSdp,
      signal,
    });
    if (!response.ok) {
      throw new Error('Could not start the voice session.');
    }
    const createdSessionId = response.headers.get('x-app-session-id');
    if (createdSessionId !== sessionId) {
      throw new Error('The BFF returned an unexpected application session ID.');
    }
    return response.text();
  },
  async closeRemoteSession(activeSessionId, token) {
    await fetch(
      `/api/realtime/sessions/${encodeURIComponent(activeSessionId)}/close`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': token },
        keepalive: true,
      },
    );
  },
  openEvents({ sessionId: activeSessionId, onMessage, onError }) {
    const eventSource = new EventSource(
      `/api/realtime/sessions/${encodeURIComponent(activeSessionId)}/events`,
    );
    eventSource.onmessage = (message) => {
      try {
        onMessage(JSON.parse(message.data));
      } catch {
        // The BFF event vocabulary is deny-by-default; malformed data is ignored.
      }
    };
    eventSource.onerror = onError;
    return eventSource;
  },
  onStatus: setStatus,
  onControls({ canMute, canStart, canStop, muted }) {
    startButton.disabled = !canStart;
    muteButton.disabled = !canMute;
    muteButton.textContent = muted ? 'Unmute' : 'Mute';
    stopButton.disabled = !canStop;
  },
});

startButton.addEventListener('click', () => void coordinator.start());
stopButton.addEventListener('click', () => void coordinator.stop());
muteButton.addEventListener('click', () => coordinator.toggleMuted());
window.addEventListener('pagehide', () => {
  void coordinator.stop();
});
