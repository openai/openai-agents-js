import assert from 'node:assert/strict';
import fs from 'node:fs';
import { URL } from 'node:url';
import vm from 'node:vm';
import { test } from 'vitest';

class Target {
  listeners = {};

  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }
}

class Element extends Target {
  attributes = new Map();
  children = [];
  dataset = {};
  disabled = false;
  textContent = '';
  clientHeight = 100;
  scrollTop = 0;

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  get scrollHeight() {
    const rowHeight = this.children.reduce(
      (height, row) => height + 140 + row.lastElementChild.textContent.length,
      0,
    );
    return Math.max(this.clientHeight, rowHeight);
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren() {
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

const source = fs.readFileSync('examples/live/static/app.js', 'utf8');

// Control WebRTC events and deferred browser work without a microphone or API.
function browserFixture() {
  const elements = Object.fromEntries(
    [
      'call-control',
      'mute',
      'audio',
      'play-audio',
      'audio-status',
      'status',
      'inference-panel',
      'inference',
      'conversation-log',
      'timeline',
      'debug-toggle',
      'debug-panel',
      'debug-events',
    ].map((id) => [id, new Element()]),
  );
  const control = elements['call-control'];
  const inference = elements['inference-panel'];
  const playAudio = elements['play-audio'];
  const debugEvents = elements['debug-events'];
  const debugToggle = elements['debug-toggle'];
  control.dataset.state = inference.dataset.state = 'idle';
  playAudio.hidden = true;
  debugToggle.checked = false;
  debugEvents.textContent = 'Connect to see session events.';
  const track = {
    enabled: true,
    stops: 0,
    stop() {
      this.stops += 1;
    },
  };
  let resolvePlay;
  let rejectPlay;
  elements.audio.play = () =>
    new Promise((resolve, reject) => {
      resolvePlay = resolve;
      rejectPlay = reject;
    });

  class Peer extends Target {
    iceGatheringState = 'complete';
    events = new Target();

    constructor() {
      super();
      Peer.last = this;
      this.events.close = () => {};
    }

    addTrack() {}

    createDataChannel() {
      return this.events;
    }

    async createOffer() {
      return { sdp: 'offer' };
    }

    async setLocalDescription(offer) {
      this.localDescription = offer;
    }

    startSession() {
      this.events.listeners.message({ data: '{"type":"session.started"}' });
    }

    close() {}
  }

  class Socket extends Target {
    static OPEN = 1;
    readyState = Socket.OPEN;
    sent = [];

    constructor() {
      super();
      Socket.last = this;
    }

    close() {
      this.readyState = 3;
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    receive(event) {
      return this.listeners.message({ data: JSON.stringify(event) });
    }
  }

  let clockMs = 0;
  const timers = new Map();
  const window = new Target();
  const mediaDevices = {
    async getUserMedia() {
      track.enabled = true;
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  };
  const context = vm.createContext({
    document: {
      querySelector: (selector) => elements[selector.slice(1)],
      createElement: () => new Element(),
    },
    navigator: { mediaDevices },
    RTCPeerConnection: Peer,
    WebSocket: Socket,
    MediaStream: class {},
    URL,
    performance: { now: () => clockMs },
    location: { protocol: 'http:', host: 'localhost:8000' },
    window,
    setTimeout: (callback, delay) => {
      const id = Symbol();
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(source, context);

  return {
    elements,
    control,
    inference,
    track,
    timers,
    mediaDevices,
    get peer() {
      return Peer.last;
    },
    get socket() {
      return Socket.last;
    },
    clickCall: () => control.listeners.click(),
    leavePage: () => window.listeners.pagehide(),
    toggleDebug: (checked) => {
      debugToggle.checked = checked;
      debugToggle.listeners.change();
    },
    advanceClock: (ms) => {
      clockMs += ms;
    },
    resolveAudio: () => resolvePlay(),
    rejectAudio: () => rejectPlay(new Error('Playback blocked.')),
  };
}

const closed = {
  type: 'closed',
  reason: 'close_requested',
  usage: { seconds: 1 },
};

test('late browser failures preserve finished and replacement calls', async () => {
  const browser = browserFixture();
  const { elements, control, inference } = browser;
  await browser.clickCall();
  const playback = browser.peer.listeners.track({ track: {} });
  await browser.socket.receive(closed);
  const finalizedStatus = elements.status.textContent;
  browser.rejectAudio();
  await playback;
  assert.equal(elements.status.textContent, finalizedStatus);
  assert.equal(elements['play-audio'].hidden, true);
  assert.equal(control.disabled, false);

  await browser.clickCall();
  const oldSocket = browser.socket;
  let rejectDescription;
  browser.peer.setRemoteDescription = () =>
    new Promise((_resolve, reject) => {
      rejectDescription = reject;
    });
  const pendingAnswer = oldSocket.receive({ type: 'answer', sdp: 'answer' });
  await oldSocket.receive(closed);
  await browser.clickCall();
  const newSocket = browser.socket;
  await newSocket.receive({ type: 'session.resumed' });
  browser.peer.startSession();
  rejectDescription(new Error('Remote description failed after cleanup.'));
  await pendingAnswer;
  await oldSocket.receive({ type: 'session.paused' });
  await oldSocket.receive({
    type: 'session.input_transcript.delta',
    delta: 'Stale call.',
  });
  assert.equal(elements.status.textContent, 'Connected.');
  assert.equal(control.textContent, 'Disconnect');
  assert.equal(control.disabled, false);
  assert.equal(elements.mute.disabled, false);
  assert.equal(inference.dataset.state, 'active');
  assert.equal(elements.timeline.children.length, 0);
  assert.equal(newSocket.readyState, 1);
});

test('does not send an offer when a socket opens after setup timeout', async () => {
  const browser = browserFixture();
  await browser.clickCall();
  const socket = browser.socket;
  socket.readyState = 0;
  const timeout = [...browser.timers.values()].find(
    ({ delay }) => delay === 45000,
  );
  timeout.callback();
  assert.equal(browser.track.enabled, false);
  socket.readyState = 1;
  socket.listeners.open();
  assert.deepEqual(socket.sent, []);
  assert.equal(socket.readyState, 3);
  assert.equal(browser.control.disabled, false);
});

test('releases microphone permission that resolves after page exit', async () => {
  const browser = browserFixture();
  let grant;
  browser.mediaDevices.getUserMedia = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const starting = browser.clickCall();
  browser.leavePage();
  grant({ getTracks: () => [browser.track] });
  await starting;
  assert.equal(browser.track.stops, 1);
  assert.equal(browser.peer, undefined);
  assert.equal(browser.socket, undefined);
});

test('offers a playback retry while keeping the call connected', async () => {
  const browser = browserFixture();
  const { elements } = browser;
  const playAudio = elements['play-audio'];
  await browser.clickCall();
  browser.peer.startSession();
  const playback = browser.peer.listeners.track({ track: {} });
  assert.equal(playAudio.hidden, true);
  assert.ok(elements.audio.srcObject);

  browser.rejectAudio();
  await playback;
  assert.equal(playAudio.hidden, false);
  assert.match(elements['audio-status'].textContent, /Play assistant audio/);

  const retry = playAudio.listeners.click();
  browser.resolveAudio();
  await retry;
  assert.equal(playAudio.hidden, true);
  assert.equal(elements['audio-status'].textContent, '');
  assert.equal(browser.control.textContent, 'Disconnect');
});

test('shows Standby and resumes on one call with the conversation intact', async () => {
  const browser = browserFixture();
  const { elements, control, inference, track } = browser;
  await browser.clickCall();
  const socket = browser.socket;
  browser.peer.startSession();
  assert.equal(inference.dataset.state, 'waiting');
  assert.equal(elements.inference.textContent, 'Waiting for speech.');

  await socket.receive({
    type: 'session.input_transcript.delta',
    delta: 'Find order ',
  });
  await socket.receive({
    type: 'session.input_transcript.delta',
    delta: 'A0042.',
  });
  assert.equal(inference.dataset.state, 'active');
  await socket.receive({ type: 'backend', status: 'working' });
  await socket.receive({
    type: 'backend',
    status: 'result_submitted',
    result: 'A0042 has shipped.',
  });
  await socket.receive({ type: 'session.paused' });
  assert.equal(inference.dataset.state, 'standby');
  assert.equal(elements.inference.textContent, 'Standby. Speak to resume.');
  assert.equal(track.enabled, true);
  assert.equal(track.stops, 0);
  assert.equal(socket.readyState, 1);

  await socket.receive({ type: 'session.resumed' });
  await socket.receive({
    type: 'session.input_transcript.delta',
    delta: 'Actually, the last digit is three.',
  });
  await socket.receive({
    type: 'session.output_transcript.delta',
    delta: 'A0043 is processing.',
  });
  assert.equal(inference.dataset.state, 'active');
  const rows = () =>
    elements.timeline.children.map((row) => [
      row.children[0].textContent,
      row.lastElementChild.textContent,
    ]);
  const conversation = [
    ['You', 'Find order A0042.'],
    [
      'Specialist',
      'Looking up the order\nResult submitted: A0042 has shipped.',
    ],
    ['You', 'Actually, the last digit is three.'],
    ['Assistant', 'A0043 is processing.'],
  ];
  assert.deepEqual(rows(), conversation);

  elements.mute.listeners.click();
  assert.equal(track.enabled, false);
  assert.equal(elements.mute.attributes.get('aria-pressed'), 'true');
  elements.mute.listeners.click();
  assert.equal(track.enabled, true);
  assert.equal(elements.mute.attributes.get('aria-pressed'), 'false');
  await browser.clickCall();
  assert.deepEqual(socket.sent, [{ type: 'close' }]);
  assert.equal(control.disabled, true);
  assert.equal(track.enabled, false);
  await socket.receive({ type: 'session.paused' });
  assert.equal(inference.dataset.state, 'idle');

  await socket.receive({
    ...closed,
    usage: { seconds: 5, active_seconds: 5, paused_seconds: 0 },
  });
  assert.match(
    elements.status.textContent,
    /5 seconds \(5 active, 0 standby\)/,
  );
  assert.equal(control.textContent, 'Connect');
  assert.equal(track.stops, 1);
  assert.deepEqual(rows(), conversation);
  await browser.clickCall();
  assert.deepEqual(rows(), []);
});

test('renders only safe citation links as text in the conversation', async () => {
  const browser = browserFixture();
  await browser.clickCall();
  await browser.socket.receive({
    type: 'web_search_sources',
    sources: [
      { url: 'https://example.com/news', title: '<b>Example news</b>' },
      { url: 'javascript:alert(1)', title: 'Invalid scheme' },
      { url: 'https://demo@example.invalid/', title: 'User information' },
      { url: 'not a URL', title: 'Invalid URL' },
    ],
  });

  const row = browser.elements.timeline.lastElementChild;
  assert.equal(row.children[0].textContent, 'Web sources');
  assert.equal(row.lastElementChild.children.length, 1);
  const link = row.lastElementChild.lastElementChild.lastElementChild;
  assert.equal(link.href, 'https://example.com/news');
  assert.equal(link.textContent, '<b>Example news</b>');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
});

test('follows new conversation entries when near the bottom', async () => {
  const browser = browserFixture();
  const log = browser.elements['conversation-log'];
  await browser.clickCall();
  const input = (delta) =>
    browser.socket.receive({ type: 'session.input_transcript.delta', delta });
  const output = (delta) =>
    browser.socket.receive({ type: 'session.output_transcript.delta', delta });
  const timeline = browser.elements.timeline;
  Object.defineProperty(log, 'scrollHeight', {
    get: () => Math.max(log.clientHeight, timeline.scrollHeight),
  });
  const bottom = () => log.scrollHeight - log.clientHeight;

  await input('Find order ');
  assert.equal(log.scrollTop, bottom());
  log.scrollTop = 10;
  await input('A0042.');
  await output('One ');
  assert.equal(log.scrollTop, 10);
  log.scrollTop = bottom() - 20;
  await output('moment.');
  assert.equal(log.scrollTop, bottom());
});

test('buffers bounded debug events and retains them through disconnect', async () => {
  const browser = browserFixture();
  const debugPanel = browser.elements['debug-panel'];
  const debugEvents = browser.elements['debug-events'];
  await browser.clickCall();
  browser.peer.startSession();
  const socket = browser.socket;
  browser.advanceClock(100);
  await socket.receive({
    type: 'session.input_transcript.delta',
    delta: 'private speech',
  });
  browser.advanceClock(100);
  await socket.receive({
    type: 'session.input_transcript.delta',
    delta: 'private correction',
  });
  await socket.receive({
    type: 'backend',
    status: 'result_submitted',
    event_id: 'event_result',
    source_response_id: 'resp_1',
    call_id: 'call_42',
    result: 'private result',
  });
  await socket.receive({
    type: 'session.resumed',
    sideband_ms: 300,
    diagnostics: [
      {
        name: 'response.created',
        event_id: 'sk-secret',
        client_event_id: 'event_continue',
        delegation_id: 'del_42',
        response_id: 'resp_2',
        sideband_ms: 250,
        payload: 'private response payload',
      },
      { name: 'private unexpected event' },
    ],
  });
  assert.equal(debugPanel.hidden, true);
  assert.equal(debugEvents.textContent, 'Connect to see session events.');

  await socket.receive(closed);
  browser.toggleDebug(true);
  assert.equal(debugPanel.hidden, false);
  assert.match(debugEvents.textContent, /\+0\.100s Received .* \(2 fragments/);
  assert.match(
    debugEvents.textContent,
    /Sent response\.item\.create event_id=event_result source_response_id=resp_1 call_id=call_42/,
  );
  assert.match(
    debugEvents.textContent,
    /Received response\.created client_event_id=event_continue delegation_id=del_42 response_id=resp_2 sideband_ms=250/,
  );
  assert.match(debugEvents.textContent, /session\.resumed sideband_ms=300/);
  assert.match(debugEvents.textContent, /Received session\.closed/);
  assert.doesNotMatch(debugEvents.textContent, /private|sk-secret/);

  await browser.clickCall();
  assert.equal(debugEvents.textContent, '+0.000s Connect requested');
  browser.toggleDebug(false);
  for (let index = 0; index < 205; index++) {
    await browser.socket.receive({
      type: 'session.resumed',
      event_id: `event_${index}`,
    });
  }
  browser.toggleDebug(true);
  const entries = debugEvents.textContent.split('\n');
  assert.equal(entries.length, 200);
  assert.match(entries[0], /event_id=event_5$/);
  assert.match(entries.at(-1), /event_id=event_204$/);
});
