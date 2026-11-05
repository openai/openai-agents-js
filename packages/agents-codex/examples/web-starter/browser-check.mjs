/* global AbortSignal, Buffer, URL, WebSocket, clearTimeout, console, fetch, process, setTimeout */
/** Dependency-free Chromium witness. Run against a fresh scripted service.
 * CHROMIUM_PATH=/path/to/chrome node browser-check.mjs http://127.0.0.1:PORT
 * CHROMIUM_PATH=/path/to/chrome node browser-check.mjs --probe
 * Requires Node 24 and a host that supports Chromium's normal sandbox.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const chrome = process.env.CHROMIUM_PATH;
const timeoutMs = 20_000;
const probe = process.argv[2] === '--probe';
const checks = [];

function witnessed(name) {
  checks.push(name);
  console.log(JSON.stringify({ check: name, passed: true }));
}

// Only the CDP commands used by this witness; every command has a finite wait.
class Cdp {
  next = 0;
  pending = new Map();
  listeners = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params);
        }
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chromium CDP connection closed'));
      }
      this.pending.clear();
    });
  }
  static async open(url) {
    const socket = new WebSocket(url);
    const client = new Cdp(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Chromium CDP connection timed out'));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('Chromium CDP connection failed'));
        },
        { once: true },
      );
    });
    return client;
  }
  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    this.socket.close();
  }
}

async function until(description, check) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  assert.ok(
    Number(process.versions.node.split('.')[0]) >= 24,
    'Use Node 24 or newer',
  );
  assert.ok(chrome, 'Set CHROMIUM_PATH to an existing Chromium executable');
  let origin;
  if (!probe) {
    const url = new URL(process.argv[2]);
    assert.ok(
      url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Supply the local scripted service URL, for example http://127.0.0.1:PORT',
    );
    assert.equal(url.username + url.password + url.search + url.hash, '');
    assert.equal(url.pathname, '/');
    origin = url.origin;
  }
  const directory = await mkdtemp(join(tmpdir(), 'agents-browser-check-'));
  const connections = [];
  let child;
  let exited;
  let failure;
  let stderr = '';
  try {
    child = spawn(
      chrome,
      [
        '--headless',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${join(directory, 'profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank',
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          XDG_CONFIG_HOME: directory,
          XDG_CACHE_HOME: directory,
        },
      },
    );
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    let exitInfo;
    exited = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        exitInfo = { code, signal };
        resolve();
      }),
    );
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-16_384);
    });
    const debuggerUrl = await until('sandboxed Chromium debugger', () => {
      if (spawnError) throw spawnError;
      if (exitInfo)
        throw new Error(
          `Chromium exited ${JSON.stringify(exitInfo)}: ${stderr.split('Received signal')[0].slice(0, 1500)}`,
        );
      return stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    });
    const browser = await Cdp.open(debuggerUrl);
    connections.push(browser);
    const debuggerHttp = new URL(debuggerUrl);
    debuggerHttp.protocol = 'http:';
    debuggerHttp.pathname = '/json/new';
    debuggerHttp.search = '?about:blank';
    const targetResponse = await fetch(debuggerHttp, {
      method: 'PUT',
      signal: AbortSignal.timeout(timeoutMs),
    });
    assert.equal(targetResponse.status, 200);
    const target = await targetResponse.json();
    const page = await Cdp.open(target.webSocketDebuggerUrl);
    connections.push(page);
    const evaluate = async (expression) => {
      const result = await page.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          `Browser evaluation failed: ${result.exceptionDetails.text}`,
        );
      return result.result.value;
    };
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    assert.equal(await evaluate('1 + 1'), 2);
    witnessed('sandboxed Chromium launch and CDP control');
    if (!probe) {
      const exceptions = [];
      page.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
        exceptions.push(exceptionDetails.text),
      );
      const downloads = new Map();
      browser.on('Browser.downloadWillBegin', (event) =>
        downloads.set(event.guid, { ...event }),
      );
      browser.on('Browser.downloadProgress', (event) => {
        const download = downloads.get(event.guid);
        if (download) Object.assign(download, event);
      });
      await browser.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: directory,
        eventsEnabled: true,
      });
      await page.send('Page.navigate', { url: `${origin}/` });
      await until('initialized user selector', () =>
        evaluate(
          `document.getElementById('identity')?.textContent === 'Selected synthetic user: alice'`,
        ),
      );
      const click = async (id) => {
        assert.equal(
          await evaluate(
            `Boolean(document.getElementById(${JSON.stringify(id)}) && !document.getElementById(${JSON.stringify(id)}).disabled)`,
          ),
          true,
          `${id} must be enabled`,
        );
        // Dispatch a real mouse click at the control, exercising browser defaults.
        const point = await evaluate(
          `(() => { const e = document.getElementById(${JSON.stringify(id)}); e.scrollIntoView(); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await page.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point,
        });
      };
      const setValue = (id, value) =>
        evaluate(
          `(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); })()`,
        );
      const text = (id) =>
        evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
      const api = (path, owner, body) =>
        evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(path + '?owner=' + owner)}, {
        cache: 'no-store', ${body === undefined ? '' : `method:'POST', headers:{'content-type':'application/json'}, body:${JSON.stringify(JSON.stringify(body))},`}
      });
      return {status:r.status, body:await r.json()};
    })()`);
      const snapshot = async (receipt, owner = 'alice') => {
        const result = await api(
          `/tasks/${encodeURIComponent(receipt)}`,
          owner,
        );
        assert.equal(result.status, 200);
        return result.body;
      };
      const phase = (value) =>
        until(
          `UI phase ${value}`,
          async () => (await text('status')) === value,
        );
      const send = async () => {
        await click('new-task');
        await setValue('prompt', 'Create my synthetic report');
        await click('send');
        await phase('approval');
        const receipt = await text('receipt');
        assert.notEqual(receipt, 'None');
        const state = await snapshot(receipt);
        assert.equal(state.phase, 'approval');
        assert.ok(state.approval?.token);
        assert.equal(await text('final'), 'No settled result yet.');
        return state;
      };

      const pending = await send();
      witnessed(
        'send reaches issued publication approval without premature result',
      );
      await click('disconnect');
      await delay(200);
      assert.equal(
        (await snapshot(pending.receipt)).approval?.token,
        pending.approval.token,
      );
      assert.equal(
        await evaluate(`document.getElementById('approval').hidden`),
        true,
      );
      await click('reconnect');
      await phase('approval');
      witnessed('passive disconnect leaves worker and issued approval alive');
      const previousDocument = await evaluate('performance.timeOrigin');
      await click('reload');
      await until('reloaded document', async () => {
        try {
          return await evaluate(
            `performance.timeOrigin !== ${previousDocument} && document.getElementById('identity')?.textContent === 'Selected synthetic user: alice'`,
          );
        } catch (error) {
          if (
            /Execution context was destroyed|Cannot find context with specified id/.test(
              String(error),
            )
          )
            return false;
          throw error;
        }
      });
      await phase('approval');
      assert.equal(await text('receipt'), pending.receipt);
      assert.equal(
        (await snapshot(pending.receipt)).approval?.token,
        pending.approval.token,
      );
      witnessed('reload recovers current application snapshot');

      await setValue('user', 'bob');
      assert.equal(await text('receipt'), 'None');
      assert.equal(await text('final'), 'No settled result yet.');
      assert.equal(
        await evaluate(`document.getElementById('approval').hidden`),
        true,
      );
      await setValue('receipt-input', pending.receipt);
      await click('recover');
      await until('foreign receipt denial in UI', async () =>
        (await text('error')).includes('HTTP 404'),
      );
      for (const [suffix, body] of [
        ['', undefined],
        ['/approval', { token: pending.approval.token, approve: true }],
        ['/stop', {}],
      ]) {
        assert.equal(
          (await api(`/tasks/${pending.receipt}${suffix}`, 'bob', body)).status,
          404,
        );
      }
      assert.equal((await snapshot(pending.receipt)).phase, 'approval');
      witnessed(
        'identity switch clears prior display; foreign receipt, approval and Stop denied',
      );

      await setValue('user', 'alice');
      await phase('approval');
      await click('approve');
      await phase('completed');
      const completed = await snapshot(pending.receipt);
      assert.ok(completed.result?.summary);
      assert.ok(completed.artifact?.handle);
      assert.deepEqual(JSON.parse(await text('final')), completed.result);
      assert.equal(
        (
          await api(`/tasks/${pending.receipt}/approval`, 'alice', {
            token: pending.approval.token,
            approve: true,
          })
        ).status,
        409,
      );
      witnessed('approval settles typed result and rejects token replay');

      const artifactPath = `/artifacts/${encodeURIComponent(completed.artifact.handle)}`;
      const expected = await evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(artifactPath + '?owner=alice')});
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (bytes.length > 65536) throw new Error('Artifact exceeds witness bound');
      return {status:r.status, type:r.headers.get('content-type'), disposition:r.headers.get('content-disposition'), bytes:Array.from(bytes)};
    })()`);
      assert.equal(expected.status, 200);
      assert.match(expected.type, /application\/json/);
      assert.match(expected.disposition, /presentation\.json/);
      const presentation = JSON.parse(
        Buffer.from(expected.bytes).toString('utf8'),
      );
      assert.ok(
        Array.isArray(presentation.slides) && presentation.slides.length > 0,
      );
      assert.ok(
        presentation.slides.every(
          (slide) => typeof slide.text === 'string' && slide.text.length > 0,
        ),
      );
      await click('download');
      const download = await until('completed browser download', () => {
        for (const item of downloads.values()) {
          if (item.state === 'canceled')
            throw new Error('Browser download canceled');
          if (item.state === 'completed') return item;
        }
      });
      assert.equal(download.suggestedFilename, 'presentation.json');
      assert.deepEqual(
        await readFile(join(directory, download.guid)),
        Buffer.from(expected.bytes),
      );
      // Check this through browser fetch without parsing or exposing private bytes.
      assert.equal(
        await evaluate(
          `fetch(${JSON.stringify(artifactPath + '?owner=bob')}).then(r => r.status)`,
        ),
        404,
      );
      witnessed(
        'browser downloads exact validated bytes with fixed name; foreign download denied',
      );

      const denied = await send();
      await click('deny');
      await phase('denied');
      assert.equal((await snapshot(denied.receipt)).artifact, undefined);
      assert.equal(
        await evaluate(`document.getElementById('download').disabled`),
        true,
      );
      witnessed('deny settles without publication');

      const stopped = await send();
      await click('stop');
      await phase('stopped');
      const stoppedState = await snapshot(stopped.receipt);
      assert.equal(stoppedState.artifact, undefined);
      assert.equal(stoppedState.approval, undefined);
      assert.equal(
        (
          await api(`/tasks/${stopped.receipt}/approval`, 'alice', {
            token: stopped.approval.token,
            approve: true,
          })
        ).status,
        409,
      );
      // A following job reaching approval witnesses that the worker slot drained.
      const following = await send();
      await click('deny');
      await phase('denied');
      assert.equal((await snapshot(following.receipt)).phase, 'denied');
      witnessed(
        'Stop settles, revokes approval and releases worker slot after cleanup',
      );
      assert.deepEqual(
        exceptions,
        [],
        'Browser must have no uncaught exceptions',
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const connection of connections.reverse()) connection.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError(
            [failure, cleanupError],
            'Witness and cleanup failed',
          )
        : cleanupError;
    }
  }
  if (failure) throw failure;
}

main().then(
  () => {
    console.log(
      JSON.stringify({
        passed: true,
        checks,
        mode: probe ? 'probe' : 'browser',
      }),
    );
  },
  (error) => {
    console.error(
      JSON.stringify({
        passed: false,
        checks,
        error: String(error),
        prerequisite:
          checks.length === 0
            ? 'Node 24, CHROMIUM_PATH pointing to Chromium, and a host permitting Chromium sandbox startup are required. No sandbox bypass is used.'
            : undefined,
      }),
    );
    process.exitCode = 1;
  },
);
