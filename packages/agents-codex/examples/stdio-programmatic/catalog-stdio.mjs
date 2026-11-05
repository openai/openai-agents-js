import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

// This finite trusted peer is an example, not a general MCP server.
const args = process.argv.slice(2);
const auditIndex = args.indexOf('--audit');
const audit = auditIndex < 0 ? undefined : args[auditIndex + 1];
function record(event) {
  if (audit)
    appendFileSync(audit, JSON.stringify({ event, pid: process.pid }) + '\n');
}
process.on('exit', () => record('exit'));
process.on('SIGTERM', () => process.exit(0));
record('start');
if (args.includes('--fail-start')) process.exit(1);

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'synthetic-catalog', version: '1' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'lookup',
            description: 'Read a synthetic catalog item by SKU.',
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: 'object',
              properties: { sku: { type: 'string' } },
              required: ['sku'],
              additionalProperties: false,
            },
          },
        ],
      };
      break;
    case 'tools/call': {
      const found =
        request.params?.name === 'lookup' &&
        request.params?.arguments?.sku === 'PAPER';
      if (found) record('lookup');
      result = {
        content: [
          {
            type: 'text',
            text: found ? 'PAPER: 5 dollars' : 'Unknown synthetic SKU',
          },
        ],
        isError: !found,
      };
      break;
    }
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n',
      );
      continue;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
  );
}
