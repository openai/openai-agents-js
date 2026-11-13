import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = '/repos/openai/openai-agents-js/actions';
const producerName = 'produce-macos / Native bundle (darwin-arm64)';
const receiptName = 'Record native transfer identity';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

async function request(path, { text = false, timeoutMs }) {
  requireValue(process.env.GH_TOKEN, 'GH_TOKEN is required');
  let body;
  try {
    // Match the existing artifact-control scripts. gh handles signed-log redirects
    // without forwarding the GitHub credential to another origin.
    body = execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      timeout: Math.min(30_000, timeoutMs),
      maxBuffer: text ? 64 * 1024 : 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const status = Number(/HTTP (\d{3})/.exec(String(cause.stderr))?.[1]);
    const error = new Error(
      'GitHub native transfer request failed' +
        (status ? ` (HTTP ${status})` : ''),
    );
    error.status = status;
    throw error;
  }
  return text ? body : JSON.parse(body);
}

async function producerForRun(identity, get) {
  const result = await get(
    `${root}/runs/${identity.runId}/jobs?filter=all&per_page=100`,
  );
  requireValue(
    Number.isSafeInteger(result.total_count) &&
      result.total_count >= 0 &&
      result.total_count <= 100 &&
      Array.isArray(result.jobs) &&
      result.jobs.length === result.total_count,
    'Incomplete or oversized native producer job listing',
  );
  const matches = result.jobs.filter((job) => job.name === producerName);
  for (const job of matches) {
    requireValue(
      positiveInteger(job.id) &&
        job.run_id === identity.runId &&
        job.head_sha === identity.headSha &&
        positiveInteger(job.run_attempt) &&
        job.run_attempt <= identity.runAttempt,
      'Native producer identity does not match this run and attempt',
    );
  }
  if (!matches.length) return undefined;
  const attempt = Math.max(...matches.map((job) => job.run_attempt));
  const latest = matches.filter((job) => job.run_attempt === attempt);
  requireValue(latest.length === 1, 'Ambiguous native producer jobs');
  return latest[0];
}

function successfulSteps(job) {
  requireValue(
    job.status === 'completed' && job.conclusion === 'success',
    'Native producer did not succeed',
  );
  requireValue(Array.isArray(job.steps), 'Missing native producer steps');
  const steps = ['Publish native bundle', receiptName].map((name) => {
    const matches = job.steps.filter((step) => step.name === name);
    requireValue(matches.length === 1, `Missing or duplicate ${name} step`);
    const step = matches[0];
    requireValue(
      positiveInteger(step.number) &&
        step.status === 'completed' &&
        step.conclusion === 'success',
      `${name} step did not succeed`,
    );
    return step;
  });
  requireValue(
    steps[0].number < steps[1].number,
    'Receipt did not follow publication',
  );
  return steps[1];
}

function parseReceipt(log, identity, job) {
  const records = log
    .split(/\r?\n/)
    .map((line) =>
      /^\uFEFF?(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z )?AGENTS_NATIVE_TRANSFER (.*)$/.exec(
        line,
      ),
    )
    .filter(Boolean);
  requireValue(
    records.length === 1,
    'Missing or duplicate native transfer receipt',
  );
  const receipt = JSON.parse(records[0][1]);
  requireValue(
    receipt?.runId === identity.runId &&
      receipt.runAttempt === job.run_attempt &&
      receipt.headSha === identity.headSha &&
      receipt.inputsHash === identity.inputsHash,
    'Native transfer receipt identity does not match its producer',
  );
  const id = receipt.artifact?.['artifact-id'];
  const digest = receipt.artifact?.['artifact-digest'];
  requireValue(
    typeof id === 'string' &&
      /^[1-9]\d*$/.test(id) &&
      positiveInteger(Number(id)) &&
      typeof digest === 'string' &&
      /^[a-f0-9]{64}$/.test(digest),
    'Invalid native transfer artifact ID or digest',
  );
  return { 'artifact-id': id, 'artifact-digest': digest };
}

export async function waitForNativeTransfer({
  runId,
  runAttempt,
  headSha,
  inputsHash,
  get = request,
  now = () => performance.now(),
  pause = sleep,
  timeoutMs = 45 * 60_000,
  pollIntervalMs = 30_000,
}) {
  requireValue(
    positiveInteger(runId) &&
      positiveInteger(runAttempt) &&
      typeof headSha === 'string' &&
      /^[a-f0-9]{40}$/.test(headSha) &&
      typeof inputsHash === 'string' &&
      /^[a-f0-9]{64}$/.test(inputsHash),
    'Invalid current-run native transfer identity',
  );
  requireValue(
    positiveInteger(timeoutMs) &&
      timeoutMs <= 45 * 60_000 &&
      positiveInteger(pollIntervalMs) &&
      pollIntervalMs <= 60_000,
    'Invalid native transfer polling bounds',
  );
  const identity = { runId, runAttempt, headSha, inputsHash };
  const deadline = now() + timeoutMs;
  const read = (path, options = {}) => {
    const remaining = Math.ceil(deadline - now());
    requireValue(
      remaining > 0,
      'Timed out waiting for the native Mac producer',
    );
    return get(path, { ...options, timeoutMs: remaining });
  };
  while (now() < deadline) {
    const job = await producerForRun(identity, read);
    if (job?.status === 'completed') {
      const step = successfulSteps(job);
      let log;
      try {
        log = await read(`${root}/jobs/${job.id}/steps/${step.number}/logs`, {
          text: true,
        });
      } catch (error) {
        // Completed-job metadata can precede availability of its step logs.
        if (error.status !== 404) throw error;
      }
      if (log !== undefined) {
        const outputs = parseReceipt(log, identity, job);
        const latest = await producerForRun(identity, read);
        requireValue(
          latest?.id === job.id && latest.run_attempt === job.run_attempt,
          'Native producer changed during receipt verification',
        );
        successfulSteps(latest);
        requireValue(
          now() < deadline,
          'Timed out waiting for the native Mac producer',
        );
        return outputs;
      }
    } else if (job) {
      requireValue(
        ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(
          job.status,
        ),
        'Unknown native producer state',
      );
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(pollIntervalMs, remaining));
  }
  throw new Error('Timed out waiting for the native Mac producer');
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    requireValue(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
    const artifact = await waitForNativeTransfer({
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      headSha: process.env.GITHUB_SHA,
      inputsHash: process.env.NATIVE_INPUTS,
    });
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `artifact=${JSON.stringify(artifact)}\n`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
