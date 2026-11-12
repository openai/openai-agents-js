import { createHash } from 'node:crypto';

/** @internal Synchronous projection of the existing native catalog name owner. */
export function projectMcpToolNames(
  servers: readonly { name: string; tools: readonly string[] }[],
  prefix = true,
): Map<string, { namespace: string; name: string }> {
  const project = (value: string) =>
    [...value]
      .map((c) => (/[A-Za-z0-9_]/.test(c) || (!prefix && c === '-') ? c : '_'))
      .join('') || '_';
  const suffix = (value: string) =>
    '_' + createHash('sha1').update(value, 'utf8').digest('hex').slice(0, 12);
  for (const server of servers) {
    for (const raw of [server.name, ...server.tools]) {
      if (
        typeof raw !== 'string' ||
        !raw ||
        raw.includes('\0') ||
        Buffer.from(raw, 'utf8').toString('utf8') !== raw
      )
        throw new TypeError(
          'MCP raw identities require nonempty valid Unicode without NUL',
        );
    }
    if (new Set(server.tools).size !== server.tools.length)
      throw new TypeError('MCP raw tool names must be unique');
  }
  const candidates = servers.flatMap((server) => {
    const rawNamespace = `${server.name}\0${server.name}\0`;
    const projected = project(server.name);
    const namespace =
      prefix && !projected.startsWith('mcp__')
        ? `mcp__${projected}`
        : projected;
    return server.tools.map((raw) => ({
      server: server.name,
      raw,
      namespace,
      name: project(raw),
      rawNamespace,
      identity: `${rawNamespace}\0${raw}\0${raw}`,
    }));
  });
  const namespaces = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const identities = namespaces.get(candidate.namespace) ?? new Set<string>();
    identities.add(candidate.rawNamespace);
    namespaces.set(candidate.namespace, identities);
  }
  for (const candidate of candidates) {
    if (namespaces.get(candidate.namespace)!.size > 1) {
      const hash = suffix(candidate.rawNamespace);
      candidate.namespace = candidate.namespace.endsWith('__')
        ? candidate.namespace.slice(0, -2) + hash + '__'
        : candidate.namespace + hash;
    }
  }
  const leaves = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = JSON.stringify([candidate.namespace, candidate.name]);
    const identities = leaves.get(key) ?? new Set<string>();
    identities.add(candidate.identity);
    leaves.set(key, identities);
  }
  for (const candidate of candidates) {
    if (
      leaves.get(JSON.stringify([candidate.namespace, candidate.name]))!.size >
      1
    )
      candidate.name += suffix(candidate.identity);
  }
  const result = new Map<string, { namespace: string; name: string }>();
  const used = new Set<string>();
  candidates.sort((a, b) =>
    Buffer.compare(Buffer.from(a.identity), Buffer.from(b.identity)),
  );
  for (const candidate of candidates) {
    let { namespace, name } = candidate;
    if (
      namespace.length + name.length + 2 > 128 ||
      used.has(namespace + name)
    ) {
      for (let attempt = 0; ; attempt++) {
        const hash = suffix(
          attempt === 0
            ? candidate.identity
            : `${candidate.identity}\0${attempt}`,
        );
        const budget = Math.max(0, 128 - candidate.namespace.length - 2);
        if (budget >= hash.length) {
          namespace = candidate.namespace;
          name = candidate.name.slice(0, budget - hash.length) + hash;
        } else {
          namespace = candidate.namespace.slice(0, 128 - hash.length - 2);
          name = hash;
        }
        if (!used.has(namespace + name)) break;
      }
    }
    used.add(namespace + name);
    result.set(JSON.stringify([candidate.server, candidate.raw]), {
      namespace,
      name,
    });
  }
  return result;
}
