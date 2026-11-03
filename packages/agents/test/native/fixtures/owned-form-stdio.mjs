/* global process */
import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const [configPath, startsPath, journalPath] = process.argv.slice(2);
const config = JSON.parse(await readFile(configPath, 'utf8'));
await appendFile(startsPath, JSON.stringify({ pid: process.pid }) + '\n');
const record = async (kind, detail = {}) => {
  await appendFile(
    journalPath,
    JSON.stringify({ kind, pid: process.pid, ...detail }) + '\n',
  );
};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, text) =>
  send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }] },
  });
const pending = new Map();
let calls = 0;
let startupAnswer;
const catalog = (id) =>
  send({
    jsonrpc: '2.0',
    id,
    result: {
      tools: [
        {
          name: 'lookup',
          description: 'Read a synthetic record',
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    },
  });
const form = async (selected) => {
  const requestId = 873;
  pending.set(requestId, selected);
  await record('form', {
    requestId,
    stage: selected.kind,
    schema: config.schema,
  });
  send({
    jsonrpc: '2.0',
    id: requestId,
    method: 'elicitation/create',
    params: {
      // Omitted mode selects a standard MCP form, not openai/form.
      message: `Supply synthetic values during ${selected.kind}`,
      requestedSchema: config.schema,
    },
  });
};

for await (const line of createInterface({ input: process.stdin })) {
  const rpc = JSON.parse(line);
  if (rpc.id === undefined) continue;
  if (!rpc.method) {
    const selected = pending.get(rpc.id);
    if (!selected) throw new Error('Reply has no pending peer request');
    pending.delete(rpc.id);
    await record('reply', {
      requestId: rpc.id,
      stage: selected.kind,
      result: rpc.result,
    });
    if (selected.kind === 'catalog') {
      startupAnswer = rpc.result;
      catalog(selected.id);
      continue;
    }
    result(
      selected.id,
      `${config.label}:pid=${process.pid}:call=${selected.ordinal}:${JSON.stringify(rpc.result)}`,
    );
    continue;
  }
  switch (rpc.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          protocolVersion: rpc.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: config.label, version: '1' },
        },
      });
      break;
    case 'tools/list':
      await record('catalog');
      if (config.startupForm && startupAnswer === undefined) {
        await form({ kind: 'catalog', id: rpc.id });
      } else {
        catalog(rpc.id);
      }
      break;
    case 'tools/call': {
      const ordinal = ++calls;
      await record('call', { ordinal });
      if (!config.form || config.startupForm) {
        result(
          rpc.id,
          `${config.label}:pid=${process.pid}:call=${ordinal}:startup=${JSON.stringify(startupAnswer ?? null)}`,
        );
        break;
      }
      await form({ kind: 'call', id: rpc.id, ordinal });
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: rpc.id, result: {} });
  }
}
