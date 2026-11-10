import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Agent, Environment } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { expect, it } from 'vitest';

const peers = ['example.com', 'github.com'];
const pem = '/etc/ssl/cert.pem';
const curl = '/usr/bin/env -i CURL_SSL_BACKEND=openssl /usr/bin/curl --disable';
const fingerprints = String.raw`/usr/bin/awk '
  BEGIN { fingerprint = "/usr/bin/openssl x509 -noout -fingerprint -sha256 2>/dev/null" }
  /^CONNECT=/ { print }
  /-----BEGIN CERTIFICATE-----/ {
    sub(/^.*-----BEGIN CERTIFICATE-----/, "-----BEGIN CERTIFICATE-----")
    in_cert = 1
  }
  in_cert {
    print | fingerprint
    if (/-----END CERTIFICATE-----/) {
      close(fingerprint)
      in_cert = 0
    }
  }
'`;

function probe(proxy: string) {
  return [
    `${curl} --version | /usr/bin/head -n 1`,
    `path=$(/usr/bin/realpath '${pem}' 2>/dev/null) || path=`,
    'printf "PEM_REALPATH=%s\\n" "$path"',
    `if test -r '${pem}'; then`,
    '  printf "PEM_READABLE=1\\n"',
    `  digest=$(/usr/bin/shasum -a 256 < '${pem}' 2>/dev/null) || digest=`,
    '  printf "PEM_SHA256=%s\\n" "${digest%% *}"',
    'else',
    '  printf "PEM_READABLE=0\\n"',
    'fi',
    ...peers.flatMap((host) => [
      `printf 'PEER=%s\\n' '${host}'`,
      'status=0',
      `receipt=$(${curl} --proto =https --silent --show-error --fail --connect-timeout 4 --max-time 4 --output /dev/null` +
        ' --write-out "CONNECT=%{http_connect} HTTP=%{http_code} VERIFY=%{ssl_verify_result}\\n%{certs}"' +
        ` --cacert '${pem}' --noproxy '' 'https://${host}/' --proxy ${proxy}) || status=$?`,
      `printf "%s\\n" "$receipt" | ${fingerprints}`,
      'printf "\\nCURL_EXIT=%s\\n" "$status"',
    ]),
  ].join('\n');
}

function summarize(output: string) {
  const version = /^curl ([\d.]+) .+$/m.exec(output);
  const backend =
    version?.[0]
      .replace(/\([^)]*\)/g, '')
      .split(/\s+/)
      .find((part) => /^LibreSSL\/[\d.]+$/.test(part)) ?? null;
  const outcomes = output
    .split(/^PEER=/m)
    .slice(1)
    .map((section) => {
      const [host, ...lines] = section.split('\n');
      if (!peers.includes(host)) throw new Error('Unexpected TLS probe peer');
      const result = lines.join('\n');
      const status = /^CONNECT=(\d{3}) HTTP=(\d{3}) VERIFY=(\d+)$/m.exec(
        result,
      );
      const [leafSha256 = null, ...issuerChainSha256] = [
        ...result.matchAll(
          /^sha256 fingerprint=((?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/gim,
        ),
      ].map(([, digest]) => digest.toUpperCase());
      return {
        host,
        connect: status?.[1] ?? null,
        http: status?.[2] ?? null,
        verify: status?.[3] ?? null,
        exit: /^CURL_EXIT=(\d+)$/m.exec(result)?.[1] ?? null,
        leafSha256,
        issuerChainSha256,
      };
    });
  return {
    pem: {
      realpath: /^PEM_REALPATH=(\/[\w./-]+)$/m.exec(output)?.[1] ?? null,
      readable: /^PEM_READABLE=1$/m.test(output),
      sha256: /^PEM_SHA256=([a-f0-9]{64})$/m.exec(output)?.[1] ?? null,
    },
    curlVersion: version?.[1] ?? null,
    backend,
    outcomes,
  };
}

it('compares stock Darwin PEM verification through the same CONNECT listener', async () => {
  expect(process.platform).toBe('darwin');
  expect(process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX).toBe('1');
  const report = process.env.SDK_DARWIN_PEM_RECEIPT;
  if (!report) throw new Error('Missing stock PEM report path');
  const cwd = await realpath(await mkdtemp(join(homedir(), '.agents-pem-')));
  try {
    const command = [
      'test -n "${HTTPS_PROXY:-}" || exit 15',
      'printf "%s\\n" "$HTTPS_PROXY" > .sdk-loopback-proxy || exit 16',
      probe('"$HTTPS_PROXY"'),
    ].join('\n');
    const { host, child } = await withScriptedResponses(
      [
        {
          items: [
            toolCall(
              'exec_command',
              {
                cmd: command,
                yield_time_ms: 20_000,
                max_output_tokens: 12_000,
              },
              { callId: 'stock-pem' },
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
            cwd,
            writePolicy: 'strict',
            tools: ['exec_command'],
            network: { allowedDomains: peers },
          }),
        });
        expect(
          (await (await session.submit('Run the probe.')).wait()).finalOutput,
        ).toBe('done');
        peer.assertExhausted();
        const output = peer.toolOutput('stock-pem');
        const proxy = (
          await readFile(join(cwd, '.sdk-loopback-proxy'), 'utf8')
        ).trim();
        const endpoint =
          /^(http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?)$/.exec(
            proxy,
          )?.[1];
        if (!output || !endpoint || !new URL(endpoint).port) {
          throw new Error('Expected a credential-free SDK loopback HTTP proxy');
        }
        const control = spawnSync('/bin/sh', ['-c', probe(`'${endpoint}'`)], {
          cwd,
          encoding: 'utf8',
          env: {},
          timeout: 12_000,
        });
        const host = summarize(control.stdout ?? '');
        const child = summarize(output);
        await writeFile(report, JSON.stringify({ host, child }));
        if (control.error || control.status !== 0) {
          throw new Error('Host stock PEM probe shell failed');
        }
        return { host, child };
      },
    );
    for (const receipt of [host, child]) {
      expect(receipt.backend).toMatch(/^LibreSSL\//);
      expect(receipt.outcomes.map((result) => result.host)).toEqual(peers);
      for (const result of receipt.outcomes) {
        expect(result.exit).not.toBeNull();
        expect(result.connect, result.host).toBe('200');
      }
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);
