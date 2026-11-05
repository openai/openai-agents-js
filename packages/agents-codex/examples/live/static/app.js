const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const mute = document.querySelector('#mute');
const audio = document.querySelector('#audio');
const status = document.querySelector('#status');
const activity = document.querySelector('#activity');
const user = document.querySelector('#user');
const assistant = document.querySelector('#assistant');
const usage = document.querySelector('#usage');
let active;

function current(call) {
  return active === call && !call.disposed;
}

function cleanup(call) {
  if (call.disposed) return;
  call.disposed = true;
  clearTimeout(call.timeout);
  call.cancelIce?.();
  call.microphone?.getTracks().forEach((track) => track.stop());
  call.events?.close();
  call.peer?.close();
  call.socket?.close();
  if (active === call) {
    active = undefined;
    audio.pause();
    audio.srcObject = null;
    start.disabled = false;
    stop.disabled = true;
    mute.disabled = true;
    mute.textContent = 'Mute microphone';
  }
}

function end(call) {
  if (!current(call) || call.closing) return;
  clearTimeout(call.timeout);
  call.closing = true;
  stop.disabled = true;
  mute.disabled = true;
  call.microphone?.getTracks().forEach((track) => {
    track.enabled = false;
  });
  if (!call.socket || call.socket.readyState !== WebSocket.OPEN) {
    status.textContent = 'Conversation ended before connecting.';
    cleanup(call);
    return;
  }
  status.textContent = 'Finishing conversation...';
  if (call.socket.readyState === WebSocket.OPEN) {
    call.socket.send(JSON.stringify({ type: 'close' }));
  }
  call.timeout = setTimeout(() => {
    if (!current(call)) return;
    status.textContent = 'Disconnected without confirmed final session usage.';
    cleanup(call);
  }, 35000);
}

async function gatherIce(call) {
  const peer = call.peer;
  if (peer.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error('ICE gathering timed out.'));
    }, 10000);
    function finish(error) {
      clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', changed);
      call.cancelIce = undefined;
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (peer.iceGatheringState === 'complete') finish();
    }
    call.cancelIce = () => finish(new Error('Conversation ended.'));
    peer.addEventListener('icegatheringstatechange', changed);
    changed();
  });
}

start.addEventListener('click', async () => {
  if (active) return;
  const call = { closing: false, finalized: false, disposed: false };
  active = call;
  start.disabled = true;
  stop.disabled = false;
  status.textContent = 'Connecting...';
  user.textContent = '';
  assistant.textContent = '';
  activity.textContent = '';
  usage.textContent =
    'Final usage is available after the server confirms the session has ended.';
  try {
    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    if (!current(call) || call.closing) {
      microphone.getTracks().forEach((track) => track.stop());
      return;
    }
    call.microphone = microphone;
    call.timeout = setTimeout(() => {
      if (current(call)) end(call);
    }, 45000);
    call.peer = new RTCPeerConnection();
    microphone
      .getTracks()
      .forEach((track) => call.peer.addTrack(track, microphone));
    call.peer.addEventListener('track', (event) => {
      if (!current(call) || call.closing) return;
      audio.srcObject = new MediaStream([event.track]);
      audio.play().catch(() => {
        if (!current(call) || call.closing) return;
        status.textContent =
          'Select play in the audio controls to hear the assistant.';
      });
    });
    call.events = call.peer.createDataChannel('oai-events');
    call.events.addEventListener('message', ({ data }) => {
      if (!current(call) || call.closing) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'session.started') {
          clearTimeout(call.timeout);
          status.textContent = 'Connected. Ask about order A0042 or A0043.';
          mute.disabled = false;
        }
        // The server alone executes tools; this channel carries session events.
      } catch {
        end(call);
      }
    });
    call.peer.addEventListener('connectionstatechange', () => {
      if (
        current(call) &&
        ['failed', 'disconnected'].includes(call.peer.connectionState)
      ) {
        end(call);
      }
    });
    const offer = await call.peer.createOffer();
    if (!current(call) || call.closing) return;
    await call.peer.setLocalDescription(offer);
    if (!current(call) || call.closing) return;
    await gatherIce(call);
    if (!current(call) || call.closing) return;
    call.socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    call.socket.addEventListener('open', () => {
      if (!current(call)) return;
      if (call.closing) {
        call.socket.send(JSON.stringify({ type: 'close' }));
        return;
      }
      call.socket.send(JSON.stringify({ sdp: call.peer.localDescription.sdp }));
    });
    call.socket.addEventListener('message', async ({ data }) => {
      if (!current(call)) return;
      try {
        const event = JSON.parse(data);
        if (event.type === 'answer') {
          if (call.closing) return;
          await call.peer.setRemoteDescription({
            type: 'answer',
            sdp: event.sdp,
          });
        } else if (event.type === 'session.input_transcript.delta') {
          user.textContent += event.delta;
        } else if (event.type === 'session.output_transcript.delta') {
          assistant.textContent += event.delta;
        } else if (event.type === 'backend') {
          activity.textContent += `${event.status}${event.result ? ': ' + event.result : ''}\n`;
        } else if (event.type === 'closed') {
          call.finalized = true;
          status.textContent = `Conversation ended (${event.reason}).`;
          usage.textContent = `Final voice usage: ${event.usage?.seconds ?? 'unknown'} seconds.`;
          cleanup(call);
        } else if (event.type === 'error') {
          call.error = event.message;
          status.textContent = event.message;
        }
      } catch {
        if (current(call)) end(call);
      }
    });
    call.socket.addEventListener('close', () => {
      if (!current(call)) return;
      if (!call.finalized) {
        status.textContent =
          call.error ?? 'Disconnected without confirmed final session usage.';
      }
      cleanup(call);
    });
    call.socket.addEventListener('error', () => {
      if (!current(call)) return;
      status.textContent = 'Could not connect to the application server.';
      cleanup(call);
    });
  } catch (error) {
    if (!current(call)) return;
    status.textContent = error.message;
    cleanup(call);
  }
});

stop.addEventListener('click', () => {
  if (active) end(active);
});
mute.addEventListener('click', () => {
  if (!active || active.closing || !active.microphone) return;
  const tracks = active.microphone.getAudioTracks();
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach((track) => {
    track.enabled = enabled;
  });
  mute.textContent = enabled ? 'Mute microphone' : 'Unmute microphone';
});
window.addEventListener('pagehide', () => {
  if (active) cleanup(active);
});
/* global document, clearTimeout, WebSocket, setTimeout, navigator, RTCPeerConnection, MediaStream, location, window */
