import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function loopbackTls(directory: string) {
  await mkdir(directory, { recursive: true });
  const ca = join(directory, 'ca.pem');
  const caKey = join(directory, 'ca.key');
  const cert = join(directory, 'server.pem');
  const key = join(directory, 'server.key');
  const csr = join(directory, 'server.csr');
  const extensions = join(directory, 'extensions');
  const openssl = (...args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore' });
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Loopback test CA',
    '-keyout',
    caKey,
    '-out',
    ca,
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    key,
    '-out',
    csr,
  );
  await writeFile(
    extensions,
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  );
  openssl(
    'x509',
    '-req',
    '-days',
    '1',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-extfile',
    extensions,
    '-out',
    cert,
  );
  return { ca, tls: { key: await readFile(key), cert: await readFile(cert) } };
}
