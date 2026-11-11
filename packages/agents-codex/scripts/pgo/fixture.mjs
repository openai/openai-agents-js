import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

let heldRequests = 0,
  abortedRequests = 0;
let requests = 0,
  errors = 0;
const turns = new Map();
const histories = new Map();
let oneShot = false,
  chain = false,
  failures = [];
const text = (item) =>
  typeof item.content === 'string'
    ? item.content
    : (item.content ?? []).map((part) => part.text ?? '').join('');
const toolText = (output) => {
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return typeof parsed === 'string' ? parsed : output;
    } catch {
      return output;
    }
  }
  if (Array.isArray(output))
    return output.map((part) => part.text ?? '').join('');
  return output;
};
const toolRecord = (session, turn, i) => ({
  call_id: `call_${session}_${turn}_${i}`,
  name: 'echo',
  arguments: { value: `tool:${session}:${turn}:${i}` },
});
const handler = async (req, res) => {
  try {
    if (req.url.startsWith('/stats')) {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          requests,
          heldRequests,
          abortedRequests,
          errors,
          turns: turns.size,
          failures,
        }),
      );
    }
    if (req.url.startsWith('/reset')) {
      turns.clear();
      histories.clear();
      failures = [];
      const params = new URL(req.url, 'http://localhost').searchParams;
      oneShot = params.get('oneShot') === 'true';
      chain = params.get('chain') === 'true';
      return res.end('ok');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = JSON.parse(body);
    requests++;
    assert.equal(request.model, 'gpt-5');
    const wire = JSON.stringify(request.input);
    const matches = [...wire.matchAll(/PGOTRAIN:([a-z0-9_-]+):(\d+):(\d+)/g)];
    assert(matches.length, 'Missing benchmark marker');
    const [, session, turn, toolCountText] = matches.at(-1);
    const toolCount = Number(toolCountText),
      key = `${session}:${turn}`;
    const step = turns.get(key) ?? 0;
    turns.set(key, step + 1);
    assert(
      step < (chain ? toolCount + 1 : toolCount ? 2 : 1),
      'Unexpected repeated model request',
    );
    const id = `resp_${session}_${turn}_${step}`;
    let answer = `PGOOUT:${session}:${turn}`.padEnd(
      Number(process.env.BENCH_OUTPUT_BYTES ?? 256),
      '.',
    );
    if (session === 'pgo_shape')
      answer = JSON.stringify({
        manifest: { label: `cargo-${turn}`, codes: [13, 29] },
        ready: true,
      });
    const prior = oneShot ? [] : (histories.get(session) ?? []);
    const users = request.input
      .filter((item) => item.role === 'user')
      .map(text);
    const assistants = request.input
      .filter((item) => item.role === 'assistant')
      .map(text);
    const currentInput = `PGOTRAIN:${session}:${turn}:${toolCount} inspect amber cargo manifest.`;
    assert.deepEqual(
      users,
      [...prior.map((item) => item.input), currentInput],
      'User history projection mismatch',
    );
    assert.deepEqual(
      assistants,
      prior.map((item) => item.answer),
      'Assistant history projection mismatch',
    );
    const completedTools = chain ? step : step > 0 ? toolCount : 0;
    const expectedCalls = [
      ...prior.flatMap((item) => item.calls),
      ...Array.from({ length: completedTools }, (_, i) =>
        toolRecord(session, turn, i),
      ),
    ];
    const observedCalls = request.input
      .filter((item) => item.type === 'function_call')
      .map((item) => ({
        call_id: item.call_id,
        name: item.name,
        arguments: JSON.parse(item.arguments),
      }));
    const observedResults = request.input
      .filter((item) => item.type === 'function_call_output')
      .map((item) => ({
        call_id: item.call_id,
        output: toolText(item.output),
      }));
    assert.deepEqual(
      observedCalls,
      expectedCalls,
      'Tool call history projection mismatch',
    );
    assert.deepEqual(
      observedResults,
      expectedCalls.map((item) => ({
        call_id: item.call_id,
        output: item.arguments.value,
      })),
      'Tool result history projection mismatch',
    );
    for (let i = 0; i < completedTools; i++) {
      const result = request.input.find(
        (item) =>
          item.type === 'function_call_output' &&
          item.call_id === `call_${session}_${turn}_${i}`,
      );
      assert(result, 'Missing tool call correlation');
      assert(
        JSON.stringify(result.output).includes(`tool:${session}:${turn}:${i}`),
        'Missing tool result',
      );
    }
    if (session === 'pgo_cancel' && turn === '31') {
      heldRequests++;
      res.once('close', () => {
        if (!res.writableEnded) abortedRequests++;
      });
      return; // Hold validated request until observed cancellation.
    }
    let output;
    if (toolCount && (chain ? step < toolCount : step === 0)) {
      assert(
        request.tools.some((t) => t.name === 'echo'),
        'Missing echo tool',
      );
      output = Array.from({ length: chain ? 1 : toolCount }, (_, offset) => {
        const i = chain ? step : offset;
        return {
          type: 'function_call',
          id: `fc_${session}_${turn}_${i}`,
          call_id: `call_${session}_${turn}_${i}`,
          name: 'echo',
          arguments: JSON.stringify({ value: `tool:${session}:${turn}:${i}` }),
          status: 'completed',
        };
      });
    } else {
      if (!oneShot)
        histories.set(session, [
          ...prior,
          {
            input: currentInput,
            answer,
            calls: Array.from({ length: toolCount }, (_, i) =>
              toolRecord(session, turn, i),
            ),
          },
        ]);
      output = [
        {
          type: 'message',
          id: `msg_${session}_${turn}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: answer, annotations: [] }],
        },
      ];
    }
    const response = {
      id,
      object: 'response',
      created_at: 0,
      status: 'completed',
      model: 'gpt-5',
      output,
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    if (!request.stream) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence_number = 0;
      const send = (event) =>
        res.write(
          `data: ${JSON.stringify({ ...event, sequence_number: sequence_number++ })}\n\n`,
        );
      send({
        type: 'response.created',
        response: { ...response, status: 'in_progress', output: [] },
      });
      for (const [output_index, item] of output.entries()) {
        send({
          type: 'response.output_item.added',
          output_index,
          item: {
            ...item,
            status: 'in_progress',
            ...(item.type === 'message' ? { content: [] } : { arguments: '' }),
          },
        });
        if (item.type === 'message') {
          send({
            type: 'response.content_part.added',
            item_id: item.id,
            output_index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          const chunks = Number(process.env.BENCH_STREAM_CHUNKS ?? 8);
          for (let i = 0; i < chunks; i++) {
            const delta = answer.slice(
              Math.floor((i * answer.length) / chunks),
              Math.floor(((i + 1) * answer.length) / chunks),
            );
            send({
              type: 'response.output_text.delta',
              item_id: item.id,
              output_index,
              content_index: 0,
              delta,
            });
          }
          send({
            type: 'response.output_text.done',
            item_id: item.id,
            output_index,
            content_index: 0,
            text: answer,
          });
          send({
            type: 'response.content_part.done',
            item_id: item.id,
            output_index,
            content_index: 0,
            part: item.content[0],
          });
        } else {
          send({
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index,
            delta: item.arguments,
          });
          send({
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index,
            arguments: item.arguments,
          });
        }
        send({ type: 'response.output_item.done', output_index, item });
      }
      send({ type: 'response.completed', response });
      res.end();
    }
  } catch (error) {
    errors++;
    if (failures.length < 5) failures.push(error.message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: error.message, type: 'fixture_error' },
      }),
    );
  }
};
const server = createServer(handler);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => server.closeAllConnections(), 1000);
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(timer);
  process.exit();
}
process.on('message', (message) => {
  if (message === 'close') void close();
});
process.on('disconnect', () => void close());
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
process.send({ port: server.address().port });
