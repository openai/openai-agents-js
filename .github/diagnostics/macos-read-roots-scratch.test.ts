import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  Environment,
  type LocalEnvironmentOptions,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { expect, it, vi } from 'vitest';

const host = 'github.com';
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const parentOnly = 'SDK_DARWIN_PARENT_ONLY_MARKER';

async function runCommand(options: LocalEnvironmentOptions, command: string) {
  return withScriptedResponses(
    [
      {
        items: [
          toolCall(
            'exec_command',
            { cmd: command, yield_time_ms: 15_000 },
            { callId: 'darwin-probe' },
          ),
        ],
      },
      { items: [text('done')] },
    ],
    async (peer) => {
      const agent = new Agent({
        provider: peer.provider,
        model: 'gpt-5.5',
        instructions: 'Run the requested command.',
      });
      await using session = await agent.session({
        environment: Environment.local({
          ...options,
          writePolicy: 'strict',
          tools: ['exec_command'],
        }),
      });
      expect(
        (await (await session.submit('Run the probe.')).wait()).finalOutput,
      ).toBe('done');
      peer.assertExhausted();
      const output = peer.toolOutput('darwin-probe');
      if (output === undefined) throw new Error('Missing Darwin probe output');
      return output;
    },
  );
}

it('honors explicit Darwin environment and writable scratch under strict Seatbelt', async () => {
  expect(process.platform).toBe('darwin');
  expect(process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX).toBe('1');
  const base = await realpath(
    await mkdtemp(join(homedir(), '.agents-darwin-scratch-')),
  );
  try {
    const cwd = join(base, 'workspace');
    const scratch = join(base, 'scratch');
    const outside = join(base, 'outside');
    await Promise.all([mkdir(cwd), mkdir(scratch), mkdir(outside)]);
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'OUTSIDE_SENTINEL\n');
    vi.stubEnv(parentOnly, 'parent-only-synthetic');
    const output = await runCommand(
      {
        cwd,
        writableRoots: [scratch],
        env: { SDK_DARWIN_FALLBACK: 'explicit', TMPDIR: scratch },
      },
      [
        'set -eu',
        'test "$SDK_DARWIN_FALLBACK" = explicit',
        'test "$TMPDIR" = ' + quote(scratch),
        'test -z "${' + parentOnly + '+set}"',
        'if /bin/cat ' + quote(sentinel) + ' >/dev/null 2>&1; then exit 11; fi',
        'if (printf changed >> ' +
          quote(sentinel) +
          ') 2>/dev/null; then exit 12; fi',
        'file=$(/usr/bin/mktemp -t sdk-darwin-fallback)',
        'case "$file" in "$TMPDIR/"*) ;; *) exit 13 ;; esac',
        'printf scratch-ok > "$file"',
        'printf "SCRATCH_OK\\n"',
      ].join('\n'),
    );
    expect(output).toContain('SCRATCH_OK');
    const files = await readdir(scratch);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^sdk-darwin-fallback\./);
    const created = join(scratch, files[0]);
    expect(await realpath(created)).toBe(created);
    expect(await readFile(created, 'utf8')).toBe('scratch-ok');
    expect(await readFile(sentinel, 'utf8')).toBe('OUTSIDE_SENTINEL\n');
  } finally {
    vi.unstubAllEnvs();
    await rm(base, { recursive: true, force: true });
  }
});

function curlCommand(mode: 'native' | 'pem') {
  const selectBackend =
    mode === 'native' ? 'export CURL_SSL_BACKEND=Secure-Transport' : '';
  const ca = mode === 'pem' ? ' --cacert /etc/ssl/cert.pem' : '';
  return [
    'unset CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR CURL_SSL_BACKEND SSLKEYLOGFILE',
    selectBackend,
    '/usr/bin/curl -q --version | /usr/bin/head -n 1',
    '/usr/bin/curl -q --proto =https --head --max-time 12 --silent --show-error --output /dev/null' +
      ' --write-out "TLS http=%{http_code} verify=%{ssl_verify_result} redirects=%{num_redirects}\\n"' +
      ca +
      ' https://' +
      host +
      '/',
    'printf "CURL_EXIT=%s\\n" "$?"',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeCurl(output: string) {
  const version = output.match(/^curl \d[^\n]*$/m)?.[0];
  const selectedBackend = version?.replace(/\([^)]*\)/g, '');
  return {
    version,
    secureTransport: /\bSecure-?Transport\b/i.test(selectedBackend ?? ''),
    exit: output.match(/^CURL_EXIT=(\d+)$/m)?.[1],
    http: output.match(/^TLS http=(\d{3}) /m)?.[1],
    verify: output.match(/^TLS http=\d{3} verify=(\d+) /m)?.[1],
    redirects: output.match(/^TLS .* redirects=(\d+)$/m)?.[1],
  };
}

function tlsSucceeded(receipt: ReturnType<typeof summarizeCurl>) {
  return (
    receipt.exit === '0' &&
    /^[1-5]\d{2}$/.test(receipt.http ?? '') &&
    receipt.verify === '0' &&
    receipt.redirects === '0'
  );
}

it('verifies stock Darwin native TLS trust under strict Seatbelt', async () => {
  expect(process.platform).toBe('darwin');
  expect(process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX).toBe('1');
  const cwd = await realpath(
    await mkdtemp(join(homedir(), '.agents-darwin-tls-')),
  );
  try {
    const runPair = async (mode: 'native' | 'pem') => {
      const command = curlCommand(mode);
      const control = spawnSync('/bin/sh', ['-c', command], {
        cwd,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin' },
        timeout: 15_000,
      });
      expect(control.error).toBeUndefined();
      expect(control.status).toBe(0);
      const outside = summarizeCurl(control.stdout);
      console.log('Stock TLS host control', mode, outside);
      const inside = summarizeCurl(
        await runCommand({ cwd, network: { allowedDomains: [host] } }, command),
      );
      console.log('Stock TLS strict Session', mode, inside);
      return { outside, inside };
    };
    const { outside, inside } = await runPair('native');
    if (
      !outside.secureTransport ||
      !inside.secureTransport ||
      !tlsSucceeded(outside) ||
      !tlsSucceeded(inside)
    ) {
      // A PEM result records only reachability and verification against that file.
      await runPair('pem');
    }
    expect(
      outside.secureTransport,
      'host control must select SecureTransport',
    ).toBe(true);
    expect(
      inside.secureTransport,
      'strict Session must select SecureTransport',
    ).toBe(true);
    expect(
      tlsSucceeded(outside),
      'host control must complete verified HTTPS',
    ).toBe(true);
    expect(
      tlsSucceeded(inside),
      'strict Session must complete verified HTTPS',
    ).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
