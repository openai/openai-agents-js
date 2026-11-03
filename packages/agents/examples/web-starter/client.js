/* global AbortController, EventSource, URL, crypto, document, fetch, localStorage, setInterval, setTimeout, window */
const $ = (id) => document.getElementById(id);
const show = (value) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const terminalPhases = new Set([
  'completed',
  'denied',
  'failed',
  'stopped',
  'expired',
  'unknown',
]);

let owner = 'alice';
let receipt = '';
let snapshot = null;
let generation = 0;
let controller = new AbortController();
let reader = null;
let connected = false;
let sending = false;
let acting = false;
let downloading = false;

const storageKey = () => `agents-web-starter:${owner}`;
const current = (saved) => saved === generation;
const endpoint = (path) => `${path}?owner=${encodeURIComponent(owner)}`;
const taskPath = (suffix = '') =>
  `/tasks/${encodeURIComponent(receipt)}${suffix}`;

function remember() {
  try {
    // Never persist snapshots, approval tokens, results or artifact handles.
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        receipt,
        requestKey: $('request-key').value,
      }),
    );
    $('storage').textContent = '';
  } catch {
    $('storage').textContent =
      'Browser storage is unavailable. Keep the receipt and request key to recover manually.';
  }
}

function controls() {
  const finished = snapshot && terminalPhases.has(snapshot.phase);
  $('send').disabled = sending;
  $('new-task').disabled = sending;
  $('prompt').disabled = sending;
  $('request-key').disabled = sending;
  $('disconnect').disabled = !receipt || !connected;
  $('reconnect').disabled = !receipt;
  $('stop').disabled =
    !receipt || acting || finished || snapshot?.phase === 'stopping';
  const canDecide =
    snapshot?.phase === 'approval' &&
    snapshot.approval &&
    !acting &&
    Date.now() < new Date(snapshot.deadlineAt).getTime();
  $('approve').disabled = !canDecide;
  $('deny').disabled = !canDecide;
  $('download').disabled = !snapshot?.artifact || downloading;
}

function clearDisplay() {
  snapshot = null;
  for (const id of ['approval-details', 'error', 'download-status']) {
    $(id).textContent = '';
  }
  $('approval').hidden = true;
  $('receipt').textContent = receipt || 'None';
  $('revision').textContent = '—';
  $('deadline').textContent = '—';
  $('final').textContent = 'No settled result yet.';
  $('status').textContent = receipt
    ? 'Loading application snapshot…'
    : 'Ready to send a task.';
  controls();
}

function detach() {
  generation++;
  reader?.close();
  reader = null;
  controller.abort();
  controller = new AbortController();
  connected = false;
  sending = acting = downloading = false;
  $('connection').textContent =
    'Reader disconnected. Worker execution is independent.';
}

function selectReceipt(value) {
  detach();
  receipt = value;
  $('receipt-input').value = receipt;
  clearDisplay();
}

async function api(path, body) {
  const response = await fetch(endpoint(path), {
    signal: controller.signal,
    cache: 'no-store',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function report(error, saved) {
  if (current(saved) && error.name !== 'AbortError') {
    $('error').textContent = error.message;
  }
}

function render(state, saved) {
  if (
    !current(saved) ||
    state.receipt !== receipt ||
    (snapshot && state.revision <= snapshot.revision)
  )
    return;
  // Each message replaces the application state; no transcript reconstruction.
  snapshot = state;
  $('status').textContent =
    state.phase === 'stopping'
      ? 'Stopping — waiting for worker cleanup.'
      : state.phase;
  $('revision').textContent = String(state.revision);
  $('deadline').textContent = new Date(state.deadlineAt).toLocaleString();
  $('approval').hidden = !state.approval;
  if (state.approval) {
    // Authority stays in memory and is never included in the rendered details.
    $('approval-details').textContent = state.approval.summary;
  } else {
    $('approval-details').textContent = '';
  }
  $('final').textContent =
    state.result === undefined ? 'No settled result yet.' : show(state.result);
  $('error').textContent = state.error === undefined ? '' : show(state.error);
  if (terminalPhases.has(state.phase)) {
    reader?.close();
    reader = null;
    connected = false;
    $('connection').textContent =
      'Task settled. Refresh to retrieve the latest application snapshot.';
  }
  controls();
}

async function refresh(saved) {
  const state = await api(taskPath());
  render(state, saved);
}

async function connect() {
  if (!receipt) return;
  // Invalidate both the previous reader and any in-flight fetch for this view.
  detach();
  clearDisplay();
  const saved = generation;
  $('connection').textContent = 'Fetching authorized snapshot…';
  try {
    await refresh(saved);
    if (!current(saved)) return;
    remember();
    if (terminalPhases.has(snapshot.phase)) return;
    const source = new EventSource(endpoint(taskPath('/events')));
    reader = source;
    connected = true;
    const receive = (event) => {
      if (!current(saved) || reader !== source) return;
      try {
        render(JSON.parse(event.data), saved);
      } catch (error) {
        report(error, saved);
      }
    };
    source.addEventListener('snapshot', receive);
    source.onopen = () => {
      if (!current(saved) || reader !== source) return;
      $('connection').textContent =
        'Reader connected. Receiving application snapshots.';
      // A fresh fetch also covers reconnect gaps; revisions discard older reads.
      refresh(saved).catch((error) => report(error, saved));
    };
    source.onerror = () => {
      if (!current(saved) || reader !== source) return;
      $('connection').textContent =
        'Reader interrupted. Reconnecting automatically; use refresh to recover the snapshot.';
    };
    controls();
  } catch (error) {
    if (current(saved)) {
      $('connection').textContent =
        'Snapshot unavailable. Check the user and receipt, then reconnect.';
    }
    report(error, saved);
  }
}

function chooseUser() {
  detach();
  owner = $('user').value;
  const pageUrl = new URL(window.location.href);
  pageUrl.searchParams.set('owner', owner);
  window.history.replaceState(null, '', pageUrl);
  receipt = '';
  $('prompt').value = 'Create my synthetic report';
  $('request-key').value = crypto.randomUUID();
  $('storage').textContent = '';
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    if (typeof saved?.receipt === 'string') receipt = saved.receipt;
    if (typeof saved?.requestKey === 'string' && saved.requestKey) {
      $('request-key').value = saved.requestKey;
    }
  } catch {
    $('storage').textContent =
      'Saved recovery details are unavailable. Enter a receipt manually or send a new task.';
  }
  $('identity').textContent = `Selected synthetic user: ${owner}`;
  $('receipt-input').value = receipt;
  clearDisplay();
  if (receipt) void connect();
}

$('user').addEventListener('change', chooseUser);
$('login').addEventListener('click', chooseUser);
$('request-key').addEventListener('change', remember);
$('new-task').addEventListener('click', () => {
  selectReceipt('');
  $('request-key').value = crypto.randomUUID();
  remember();
});
$('receipt-form').addEventListener('submit', (event) => {
  event.preventDefault();
  selectReceipt($('receipt-input').value.trim());
  void connect();
});
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending) return;
  const requestKey = $('request-key').value;
  const task = $('prompt').value;
  selectReceipt('');
  remember();
  const saved = generation;
  sending = true;
  $('status').textContent = 'Submitting task…';
  controls();
  try {
    const state = await api('/tasks', { requestKey, task });
    if (!current(saved)) return;
    selectReceipt(state.receipt);
    remember();
    render(state, generation);
    void connect();
  } catch (error) {
    report(error, saved);
    if (current(saved))
      $('status').textContent =
        'Submission unconfirmed. Retry the same key and request to recover.';
  } finally {
    if (current(saved)) {
      sending = false;
      controls();
    }
  }
});

async function act(suffix, body) {
  if (!receipt || acting) return;
  const saved = generation;
  acting = true;
  $('error').textContent = '';
  controls();
  try {
    const state = await api(taskPath(suffix), body);
    render(state, saved);
  } catch (error) {
    // Reconcile uncertain acceptance instead of automatically replaying authority.
    if (current(saved)) {
      try {
        await refresh(saved);
      } catch (refreshError) {
        report(refreshError, saved);
      }
    }
    report(error, saved);
  } finally {
    if (current(saved)) {
      acting = false;
      controls();
    }
  }
}

for (const [id, approve] of [
  ['approve', true],
  ['deny', false],
]) {
  $(id).addEventListener('click', () => {
    if (!snapshot?.approval || $(id).disabled) return;
    void act('/approval', { token: snapshot.approval.token, approve });
  });
}
$('stop').addEventListener('click', () => {
  void act('/stop', {});
});
$('disconnect').addEventListener('click', () => {
  detach();
  clearDisplay();
  $('status').textContent =
    'Reader detached. Work continues; reconnect or reload to recover.';
});
$('reconnect').addEventListener('click', () => {
  void connect();
});
$('reload').addEventListener('click', () => window.location.reload());
$('download').addEventListener('click', async () => {
  if (!snapshot?.artifact || downloading) return;
  const saved = generation;
  const handle = snapshot.artifact.handle;
  downloading = true;
  $('error').textContent = '';
  controls();
  try {
    const response = await fetch(
      endpoint(`/artifacts/${encodeURIComponent(handle)}`),
      {
        signal: controller.signal,
        cache: 'no-store',
      },
    );
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    // Preserve exactly the validated bytes returned by the server.
    const bytes = await response.blob();
    if (!current(saved)) return;
    const url = URL.createObjectURL(bytes);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'presentation.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('download-status').textContent = 'Download requested: presentation.json';
  } catch (error) {
    report(error, saved);
  } finally {
    if (current(saved)) {
      downloading = false;
      controls();
    }
  }
});

// Expiry changes control availability without inventing a local task outcome.
setInterval(controls, 1000);
window.addEventListener('pagehide', detach);
$('user').value =
  new URL(window.location.href).searchParams.get('owner') === 'bob'
    ? 'bob'
    : 'alice';
chooseUser();
