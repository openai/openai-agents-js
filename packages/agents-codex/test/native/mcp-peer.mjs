import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const [rosterPath, callsPath, startsPath] = process.argv.slice(2);
if (startsPath)
  await appendFile(startsPath, JSON.stringify({ pid: process.pid }) + '\n');
const lines = createInterface({ input: process.stdin });
let urlTool;
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const roster = JSON.parse(await readFile(rosterPath, 'utf8'));
  if (!request.method && request.id === 'url-consent' && urlTool) {
    await appendFile(roster.urlReplies, JSON.stringify(request) + '\n');
    if (request.result?.action === 'accept')
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/elicitation/complete',
          params: { elicitationId: 'stdio-interaction' },
        }) + '\n',
      );
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: urlTool.id,
        result: roster.result,
      }) + '\n',
    );
    urlTool = undefined;
    continue;
  }
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: roster.tools };
      break;
    case 'tools/call': {
      const recorded =
        roster.exitAfterKey === undefined
          ? request.params
          : { ...request.params, pid: process.pid };
      await appendFile(callsPath, JSON.stringify(recorded) + '\n');
      if (
        roster.exitAfterKey !== undefined &&
        request.params.arguments?.key === roster.exitAfterKey
      )
        process.exit(0);
      if (roster.urlReplies) {
        urlTool = request;
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'url-consent',
            method: 'elicitation/create',
            params: {
              mode: 'url',
              elicitationId: 'stdio-interaction',
              url: 'https://verification.invalid/stdio',
              message: 'Synthetic stdio consent',
            },
          }) + '\n',
        );
        continue;
      }
      // Leave this actual native RPC pending until its owner closes the pipe.
      if (roster.holdCall) continue;
      result = roster.result;
      break;
    }
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'unsupported method' },
        }) + '\n',
      );
      continue;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
  );
}
import process from 'node:process';
