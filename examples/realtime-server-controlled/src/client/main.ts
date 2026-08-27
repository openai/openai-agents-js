import './style.css';
import { AudioOnlyWebRtc } from './audioOnlyWebRtc';
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

let csrfToken: string | null = null;

function setStatus(state: keyof typeof statusCopy) {
  const copy = statusCopy[state];
  orb.dataset.state = state;
  statusTitle.textContent = copy.title;
  statusDetail.textContent = copy.detail;
}

async function getCsrfToken(): Promise<string> {
  if (csrfToken) {
    return csrfToken;
  }
  const response = await fetch('/api/auth/session', {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('Could not initialize the application session.');
  }
  const body = (await response.json()) as { csrfToken?: unknown };
  if (typeof body.csrfToken !== 'string') {
    throw new Error('The application session returned an invalid CSRF token.');
  }
  csrfToken = body.csrfToken;
  return csrfToken;
}

const coordinator = new VoiceSessionCoordinator({
  getCsrfToken,
  createConnection: () => new AudioOnlyWebRtc({ remoteAudio }),
  async exchangeOffer({ offerSdp, onSessionCreated, signal, token }) {
    const response = await fetch('/api/realtime/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/sdp',
        'X-CSRF-Token': token,
      },
      body: offerSdp,
      signal,
    });
    if (!response.ok) {
      throw new Error('Could not start the voice session.');
    }
    const createdSessionId = response.headers.get('x-app-session-id');
    if (!createdSessionId) {
      throw new Error('The BFF did not return an application session ID.');
    }
    await onSessionCreated(createdSessionId);
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
