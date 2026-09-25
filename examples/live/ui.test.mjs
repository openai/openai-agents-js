import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'vitest';

class Target {
  constructor() {
    this.listeners = {};
    this.disabled = false;
    this.textContent = '';
  }
  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
}
const elements = Object.fromEntries(
  [
    'start',
    'stop',
    'mute',
    'audio',
    'status',
    'activity',
    'user',
    'assistant',
  ].map((id) => [id, new Target()]),
);
let rejectPlay;
elements.audio.play = () =>
  new Promise((_resolve, reject) => {
    rejectPlay = reject;
  });
class Peer extends Target {
  constructor() {
    super();
    this.iceGatheringState = 'complete';
    Peer.last = this;
  }
  addTrack() {}
  createDataChannel() {
    this.events = new Target();
    this.events.close = () => {};
    return this.events;
  }
  async createOffer() {
    return { sdp: 'offer' };
  }
  async setLocalDescription(offer) {
    this.localDescription = offer;
  }
  close() {}
}
class Socket extends Target {
  constructor() {
    super();
    this.readyState = 1;
    Socket.last = this;
  }
  close() {
    this.readyState = 3;
  }
  send() {}
}
Socket.OPEN = 1;
const track = { stop() {}, enabled: true };
const timers = [];
const context = vm.createContext({
  document: { querySelector: (selector) => elements[selector.slice(1)] },
  navigator: {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  },
  RTCPeerConnection: Peer,
  WebSocket: Socket,
  MediaStream: class {},
  location: { protocol: 'http:', host: 'localhost:8000' },
  window: new Target(),
  setTimeout: (callback, delay) => timers.push({ callback, delay }),
  clearTimeout() {},
});
vm.runInContext(
  fs.readFileSync('examples/live/static/app.js', 'utf8'),
  context,
);
// Control pending playback without microphone, browser, or API access.
test('late browser failures preserve finished and replacement calls', async () => {
  await elements.start.listeners.click();
  Peer.last.listeners.track({ track: {} });
  await Socket.last.listeners.message({
    data: JSON.stringify({
      type: 'closed',
      reason: 'close_requested',
      usage: { seconds: 1 },
    }),
  });
  const finalizedStatus = elements.status.textContent;
  rejectPlay(new Error('Playback aborted during cleanup.'));
  await Promise.resolve();
  assert.equal(elements.status.textContent, finalizedStatus);
  assert.equal(elements.start.disabled, false);

  await elements.start.listeners.click();
  const oldSocket = Socket.last;
  let rejectDescription;
  Peer.last.setRemoteDescription = () =>
    new Promise((_resolve, reject) => {
      rejectDescription = reject;
    });
  const pendingAnswer = oldSocket.listeners.message({
    data: JSON.stringify({ type: 'answer', sdp: 'answer' }),
  });
  await oldSocket.listeners.message({
    data: JSON.stringify({
      type: 'closed',
      reason: 'close_requested',
      usage: { seconds: 1 },
    }),
  });
  await elements.start.listeners.click();
  Peer.last.events.listeners.message({
    data: JSON.stringify({ type: 'session.started' }),
  });
  const nextStatus = elements.status.textContent;
  const nextSocket = Socket.last;
  assert.equal(elements.stop.disabled, false);
  assert.equal(elements.mute.disabled, false);
  rejectDescription(new Error('Remote description failed after cleanup.'));
  await pendingAnswer;
  assert.equal(elements.status.textContent, nextStatus);
  assert.equal(elements.stop.disabled, false);
  assert.equal(elements.mute.disabled, false);
  assert.equal(nextSocket.readyState, Socket.OPEN);
  await nextSocket.listeners.message({
    data: JSON.stringify({
      type: 'closed',
      reason: 'close_requested',
      usage: { seconds: 1 },
    }),
  });
});

test('does not send an offer when a socket opens after setup timeout', async () => {
  await elements.start.listeners.click();
  const socket = Socket.last;
  socket.readyState = 0;
  const sent = [];
  socket.send = (data) => sent.push(data);
  timers.findLast(({ delay }) => delay === 45000).callback();
  assert.equal(track.enabled, false);
  socket.readyState = Socket.OPEN;
  socket.listeners.open();
  assert.deepEqual(sent, []);
  assert.equal(socket.readyState, 3);
  assert.equal(elements.start.disabled, false);
});

test('releases microphone permission that resolves after page exit', async () => {
  let grant;
  context.navigator.mediaDevices.getUserMedia = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  let stopped = false;
  const previousPeer = Peer.last;
  const previousSocket = Socket.last;
  const starting = elements.start.listeners.click();
  context.window.listeners.pagehide();
  grant({
    getTracks: () => [
      {
        stop() {
          stopped = true;
        },
      },
    ],
  });
  await starting;
  assert.equal(stopped, true);
  assert.equal(Peer.last, previousPeer);
  assert.equal(Socket.last, previousSocket);
});
