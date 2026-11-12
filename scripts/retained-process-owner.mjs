import assert from 'node:assert/strict';
import process from 'node:process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function processInfo(pid) {
  try {
    if ((await stat(`/proc/${pid}`)).uid !== process.getuid()) return;
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), group: Number(fields[2]), birth: fields[19] };
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
  }
}
async function processes() {
  const ids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  return (await Promise.all(ids.map(processInfo))).filter(Boolean);
}

export function groupWitness(original, current, group) {
  return Boolean(original && current && /^\d+$/.test(original.birth ?? '') && original.pid === current.pid && original.birth === current.birth && original.group === group && current.group === group);
}

// Linux-only test ownership: one new process group plus observed descendants.
// Birth identities prevent signalling a PID that the kernel has reused.
export function runClosed(command, args, options = {}, { deadlineMs = 120_000 } = {}) {
  assert.equal(process.platform, 'linux');
  return new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
    const known = new Map();
    const leaderReady = (child.pid ? processInfo(child.pid) : Promise.resolve()).then((row) => {
      if (row && row.group === child.pid) known.set(row.pid, row);
      return row;
    });
    let scanPending;
    const scan = () => {
      if (scanPending) return scanPending;
      scanPending = (async () => {
        await leaderReady;
        const rows = await processes();
        const witnessed = rows.some((row) => groupWitness(known.get(row.pid), row, child.pid));
        if (!witnessed && rows.some((row) => row.group === child.pid))
          observerError ??= new Error('Process-group origin has not been witnessed');
        const owned = new Map(rows.filter((row) => (witnessed && row.group === child.pid) || known.get(row.pid)?.birth === row.birth).map((row) => [row.pid, row]));
        let changed;
        do {
          changed = false;
          for (const row of rows) if (!owned.has(row.pid) && owned.has(row.ppid)) {
            owned.set(row.pid, row); changed = true;
          }
        } while (changed);
        for (const [pid, row] of owned) known.set(pid, row);
        return [...owned.values()];
      })().finally(() => { scanPending = undefined; });
      return scanPending;
    };
    let observerError;
    const observe = () => { void scan().catch((error) => { observerError ??= error; }); };
    const observer = setInterval(observe, 100);
    observe();
    let spawnError;
    let timedOut = false;
    let parentSignal;
    let termination;
    let forced = false;
    const signal = async (rows, name) => {
      let groupSignalled = false;
      for (const row of rows.filter((item) => item.group === child.pid)) {
        const current = await processInfo(row.pid);
        if (!groupWitness(row, current, child.pid)) continue;
        try { process.kill(-child.pid, name); groupSignalled = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        break;
      }
      for (const row of rows.filter((item) => item.group !== child.pid)) {
        const current = await processInfo(row.pid);
        if (current?.birth !== row.birth) continue;
        try { process.kill(row.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      return groupSignalled;
    };
    const retire = () => termination ??= (async () => {
      forced = true;
      let rows = await scan();
      await signal(rows, 'SIGTERM');
      for (let i = 0; i < 20 && rows.length; i++) { await pause(50); rows = await scan(); }
      if (rows.length) await signal(rows, 'SIGKILL');
      for (let i = 0; i < 100 && rows.length; i++) {
        await pause(50); rows = await scan();
        if (rows.length) await signal(rows, 'SIGKILL');
      }
      return { joined: rows.length === 0, remaining: rows.map(({ pid, birth, group, state }) => ({ pid, birth, group, state })) };
    })();
    let fallback;
    const failedCensus = (error) => fallback ??= (async () => {
      observerError ??= error;
      await leaderReady;
      const remainingKnown = async () => (await Promise.all([...known.values()].map(async (row) => {
        const current = await processInfo(row.pid);
        return current?.birth === row.birth ? current : undefined;
      }))).filter(Boolean);
      let rows = await remainingKnown();
      const groupSignalled = await signal(rows, 'SIGKILL');
      for (let i = 0; i < 100 && rows.length; i++) {
        await pause(50); rows = await remainingKnown();
        if (rows.length) await signal(rows, 'SIGKILL');
      }
      // A failed census has not been proving complete retirement.
      return { joined: false, knownRetired: rows.length === 0, groupSignalled,
        remaining: rows, reason: 'ownership-census-failed' };
    })();
    const stopOwned = () => retire().catch(failedCensus);
    const shutdown = (name) => {
      parentSignal ??= name;
      void stopOwned().catch((error) => { observerError ??= error; });
    };
    const terminated = () => shutdown('SIGTERM');
    const interrupted = () => shutdown('SIGINT');
    process.on('SIGTERM', terminated);
    process.on('SIGINT', interrupted);
    const releaseShutdown = () => {
      process.off('SIGTERM', terminated);
      process.off('SIGINT', interrupted);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      void stopOwned().catch((error) => { observerError ??= error; });
    }, deadlineMs);
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signalName) => {
      clearTimeout(deadline); clearInterval(observer);
      void (async () => {
        let cleanup;
        if (termination) cleanup = await stopOwned();
        else {
          let rows = await scan();
          for (let i = 0; i < 10 && rows.length; i++) { await pause(50); rows = await scan(); }
          cleanup = rows.length ? await stopOwned() : { joined: true, remaining: [] };
        }
        if (observerError) cleanup.joined = false;
        cleanup.scope = 'new-process-group-and-observed-descendants';
        cleanup.parentSignal = parentSignal;
        cleanup.observed = [...known.values()].map(({ pid, birth, group }) => ({ pid, birth, group }));
        if (spawnError || observerError || parentSignal || timedOut || forced || signalName || code !== 0 || !cleanup.joined) {
          const error = new Error(`Owned child failed: code=${code}; signal=${signalName}; timeout=${timedOut}; forced=${forced}; joined=${cleanup.joined}; spawnError=${Boolean(spawnError)}; observerError=${Boolean(observerError)}`);
          error.cleanup = cleanup;
          error.parentSignal = parentSignal;
          throw error;
        }
        releaseShutdown();
        done({ code, signal: signalName, close: true, cleanup });
      })().catch(async (error) => {
        if (!error.cleanup) {
          try { error.cleanup = await failedCensus(error); } catch {
            // Fallback failure has been leaving an unjoined cleanup receipt below.
          }
        }
        error.cleanup ??= { joined: false, remaining: [], reason: 'ownership-census-or-retirement-failed' };
        error.parentSignal ??= parentSignal;
        releaseShutdown();
        reject(error);
      });
    });
  });
}
