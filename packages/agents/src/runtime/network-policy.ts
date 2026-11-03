import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

/** Managed executor rules, applied to hosts across all ports. */
export interface NetworkPolicy {
  readonly allowedDomains?: readonly string[];
  readonly deniedDomains?: readonly string[];
  /** Linux requires access to every reachable Unix socket, including privileged sockets. */
  readonly allowAllUnixSockets?: boolean;
  /** May permit traffic outside domain rules; macOS also permits direct port 53 traffic. */
  readonly allowLocalBinding?: boolean;
}

export type CapturedNetworkPolicy = Readonly<{
  allowedDomains: readonly string[];
  deniedDomains: readonly string[];
  allowAllUnixSockets: boolean;
  allowLocalBinding: boolean;
}>;

const declarationSchema = z
  .object({
    allowedDomains: z.array(z.string()).default([]),
    deniedDomains: z.array(z.string()).default([]),
    allowAllUnixSockets: z.boolean().default(false),
    allowLocalBinding: z.boolean().default(false),
  })
  .strict();

/** @internal Wire fields consumed by the native managed proxy adapter. */
export const networkPolicyWireSchema = z
  .object({
    allowed_domains: z.array(z.string()),
    denied_domains: z.array(z.string()),
    allow_all_unix_sockets: z.boolean(),
    allow_local_binding: z.boolean(),
  })
  .strict();

function canonicalDomain(value: string): string {
  // A rule cannot imply a narrower port or URL grant than the proxy enforces.
  if (/[^\x21-\x7e]|[/@#\\]/.test(value))
    throw new TypeError('Network rules require an ASCII host or host pattern');
  if (value.includes(':') || value.includes('[')) {
    const host =
      value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    if (isIP(host) !== 6)
      throw new TypeError(
        'Network rules require a host without a port or zone',
      );
    const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    // Format an already parsed mapped address like Python's IPv6Address.
    const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return canonical;
  }
  const canonical = value.replace(/\.+$/, '').toLowerCase();
  if (!canonical || (['*', '**'].includes(canonical) && value.endsWith('.')))
    throw new TypeError(
      'Network rules require a nonempty host or host pattern',
    );
  return canonical;
}

/** @internal Capture caller input once; later mutation cannot change authority. */
export function captureNetworkPolicy(
  value: NetworkPolicy,
): CapturedNetworkPolicy {
  const parsed = declarationSchema.parse(value);
  const denied = new Set(parsed.deniedDomains.map(canonicalDomain));
  const allowed = new Set(parsed.allowedDomains.map(canonicalDomain));
  return Object.freeze({
    allowedDomains: Object.freeze(
      [...allowed].filter((host) => !denied.has(host)).sort(),
    ),
    deniedDomains: Object.freeze([...denied].sort()),
    allowAllUnixSockets: parsed.allowAllUnixSockets,
    allowLocalBinding: parsed.allowLocalBinding,
  });
}

/** @internal One canonical value supplies both native policy and saved identity. */
export function networkPolicyWire(policy: CapturedNetworkPolicy) {
  return {
    allow_all_unix_sockets: policy.allowAllUnixSockets,
    allow_local_binding: policy.allowLocalBinding,
    allowed_domains: [...policy.allowedDomains],
    denied_domains: [...policy.deniedDomains],
  };
}

/** @internal No rule text or credentials are persisted in the checkpoint. */
export function networkPolicyDigest(policy: CapturedNetworkPolicy | undefined) {
  return policy === undefined
    ? undefined
    : `sha256:v1:${createHash('sha256')
        .update(JSON.stringify(networkPolicyWire(policy)))
        .digest('hex')}`;
}
