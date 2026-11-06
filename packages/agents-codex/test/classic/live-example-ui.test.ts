import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, test } from 'vitest';

const source = readFileSync(
  new URL('../../../../examples/codex/live/static/app.js', import.meta.url),
  'utf8',
);

type Track = { enabled: boolean; stopped: boolean; stop(): void };
type Stream = { getTracks(): Track[]; getAudioTracks(): Track[] };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Controlled browser boundaries expose late callbacks without real media or API access.
function browser() {
  class Target {
    listeners: Record<string, (event: Record<string, unknown>) => unknown> = {};
    closed = false;
    srcObject: unknown = null;
    play: () => Promise<void> = async () => {};
    pause() {}
    close() {
      this.closed = true;
    }
    disabled = false;
    textContent = '';
    addEventListener(
      name: string,
      callback: (event: Record<string, unknown>) => unknown,
    ) {
      this.listeners[name] = callback;
    }
    removeEventListener(
      name: string,
      callback: (event: Record<string, unknown>) => unknown,
    ) {
      if (this.listeners[name] === callback) delete this.listeners[name];
    }
    emit(name: string, event: Record<string, unknown> = {}) {
      return this.listeners[name]?.(event);
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
      'usage',
    ].map((id) => [id, new Target()]),
  );
  const plays: ReturnType<typeof deferred<void>>[] = [];
  elements.audio.play = () => {
    const p = deferred();
    plays.push(p);
    return p.promise;
  };
  elements.audio.pause = () => {};
  const microphones: { track: Track; stream: Stream }[] = [];
  let pendingMedia: ReturnType<typeof deferred<Stream>> | undefined;
  function microphone() {
    const track = {
      enabled: true,
      stopped: false,
      stop() {
        this.stopped = true;
      },
    };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    microphones.push({ track, stream });
    return stream;
  }
  const peers: Peer[] = [];
  class Peer extends Target {
    iceGatheringState = 'complete';
    events!: Target;
    localDescription?: { sdp: string; type?: string };
    answer?: { sdp: string; type?: string };
    constructor() {
      super();
      peers.push(this);
    }
    addTrack() {}
    createDataChannel() {
      this.events = new Target();
      this.events.close = () => {
        this.events.closed = true;
      };
      return this.events;
    }
    async createOffer() {
      return { type: 'offer', sdp: 'offer-sdp' };
    }
    async setLocalDescription(offer: { sdp: string; type?: string }) {
      this.localDescription = offer;
    }
    async setRemoteDescription(answer: { sdp: string; type?: string }) {
      this.answer = answer;
    }
    close() {
      this.closed = true;
    }
  }
  const sockets: Socket[] = [];
  class Socket extends Target {
    static OPEN = 1;
    readyState = 1;
    sent: unknown[] = [];
    url: string;
    constructor(url: string) {
      super();
      this.url = url;
      sockets.push(this);
    }
    close() {
      this.readyState = 3;
    }
    send(message: string) {
      this.sent.push(JSON.parse(message));
    }
  }
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const window = new Target();
  vm.runInNewContext(source, {
    document: {
      querySelector: (selector: string) => elements[selector.slice(1)],
    },
    navigator: {
      mediaDevices: {
        getUserMedia: () =>
          pendingMedia?.promise ?? Promise.resolve(microphone()),
      },
    },
    RTCPeerConnection: Peer,
    WebSocket: Socket,
    MediaStream: class {},
    location: { protocol: 'http:', host: 'localhost:8000' },
    window,
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    elements,
    peers,
    sockets,
    microphones,
    plays,
    window,
    timers,
    delayMedia() {
      pendingMedia = deferred<Stream>();
      return pendingMedia;
    },
    microphone,
    async start() {
      await elements.start.emit('click');
      return sockets.at(-1)!;
    },
    event(socket: Socket, event: Record<string, unknown>) {
      return socket.emit('message', { data: JSON.stringify(event) });
    },
  };
}

test('offer, mute, transcripts, backend results and final usage stay separate', async () => {
  const b = browser();
  const socket = await b.start();
  socket.emit('open');
  expect(socket.url).toBe('ws://localhost:8000/ws');
  expect(socket.sent).toEqual([{ sdp: 'offer-sdp' }]);
  b.peers[0].events.emit('message', { data: '{"type":"session.started"}' });
  expect(b.elements.mute.disabled).toBe(false);
  b.elements.mute.emit('click');
  expect(b.microphones[0].track.enabled).toBe(false);
  expect(b.elements.mute.textContent).toBe('Unmute microphone');
  await b.event(socket, {
    type: 'answer',
    sdp: 'answer-sdp',
    session_id: 'session-1',
  });
  expect(b.peers[0].answer?.sdp).toBe('answer-sdp');
  await b.event(socket, {
    type: 'session.input_transcript.delta',
    delta: 'My order?',
  });
  await b.event(socket, {
    type: 'session.output_transcript.delta',
    delta: 'Checking.',
  });
  await b.event(socket, {
    type: 'backend',
    status: 'submitted',
    result: 'Order shipped.',
  });
  expect(b.elements.user.textContent).toBe('My order?');
  expect(b.elements.assistant.textContent).toBe('Checking.');
  expect(b.elements.activity.textContent).toBe('submitted: Order shipped.\n');
  expect(b.elements.usage.textContent).toMatch(/after the server confirms/);
  b.elements.stop.emit('click');
  expect(socket.sent.at(-1)).toEqual({ type: 'close' });
  await b.event(socket, {
    type: 'closed',
    reason: 'close_requested',
    usage: { seconds: 3 },
  });
  expect(b.elements.usage.textContent).toBe('Final voice usage: 3 seconds.');
  expect(b.elements.start.disabled).toBe(false);
  expect(b.microphones[0].track.stopped).toBe(true);
  expect(b.peers[0].closed).toBe(true);
  expect(b.peers[0].events.closed).toBe(true);
  expect(socket.readyState).toBe(3);
  expect(b.elements.audio.srcObject).toBe(null);
});

test('autoplay fallback works and late failures cannot change finalized or replacement calls', async () => {
  const b = browser();
  const first = await b.start();
  b.peers[0].emit('track', { track: {} });
  b.plays[0].reject(new Error('Autoplay blocked.'));
  await Promise.resolve();
  expect(b.elements.status.textContent).toMatch(
    /Select play in the audio controls/,
  );
  b.peers[0].emit('track', { track: {} });
  const answer = deferred();
  b.peers[0].setRemoteDescription = () => answer.promise;
  const pendingAnswer = b.event(first, { type: 'answer', sdp: 'answer' });
  await b.event(first, {
    type: 'closed',
    reason: 'close_requested',
    usage: { seconds: 1 },
  });
  const finalized = b.elements.status.textContent;
  b.plays[1].reject(new Error('Playback aborted during cleanup.'));
  await Promise.resolve();
  expect(b.elements.status.textContent).toBe(finalized);
  const second = await b.start();
  b.peers[1].events.emit('message', { data: '{"type":"session.started"}' });
  const connected = b.elements.status.textContent;
  answer.reject(new Error('Late remote description failure.'));
  await pendingAnswer;
  await b.event(first, { type: 'backend', status: 'late', result: 'Ignore.' });
  first.emit('close');
  first.emit('error');
  expect(b.elements.status.textContent).toBe(connected);
  expect(b.elements.activity.textContent).toBe('');
  expect(b.elements.mute.disabled).toBe(false);
  expect(second.readyState).toBe(1);
});

test('ending while microphone permission is pending stops late tracks without replacing the next call', async () => {
  const b = browser();
  const permission = b.delayMedia();
  const pending = b.start();
  b.elements.stop.emit('click');
  const finalized = b.elements.status.textContent;
  permission.resolve(b.microphone());
  await pending;
  expect(b.microphones[0].track.stopped).toBe(true);
  expect(b.peers.length).toBe(0);
  expect(b.sockets.length).toBe(0);
  expect(b.elements.status.textContent).toBe(finalized);
  expect(b.elements.start.disabled).toBe(false);
});

test('unexpected socket closure does not invent final usage; page exit releases all resources', async () => {
  const b = browser();
  const first = await b.start();
  first.emit('close');
  expect(b.elements.status.textContent).toMatch(
    /without confirmed final session usage/,
  );
  expect(b.elements.usage.textContent).not.toMatch(/Final voice usage:/);
  const second = await b.start();
  b.window.emit('pagehide');
  expect(b.microphones[1].track.stopped).toBe(true);
  expect(b.peers[1].closed).toBe(true);
  expect(b.peers[1].events.closed).toBe(true);
  expect(second.readyState).toBe(3);
});
