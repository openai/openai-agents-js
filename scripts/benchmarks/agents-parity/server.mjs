import { createServer } from 'node:http';
import assert from 'node:assert/strict';

let requests = 0,
  errors = 0,
  bytes = 0;
const turns = new Map();
const histories = new Map();
let oneShot = false,
  chain = false,
  longInput = false,
  modelSockets = new WeakSet(),
  modelConnections = 0,
  failures = [];
let measuring = false,
  measuredSockets = new WeakSet(),
  measuredModelConnections = 0;
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
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/stats')) {
      const phase = new URL(req.url, 'http://localhost').searchParams.get(
        'phase',
      );
      if (phase === 'begin') {
        measuring = true;
        measuredSockets = new WeakSet();
        measuredModelConnections = 0;
      }
      if (phase === 'end') measuring = false;
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          requests,
          errors,
          bytes,
          turns: turns.size,
          modelConnections,
          measuredModelConnections,
          failures,
          cpu: process.cpuUsage(),
        }),
      );
    }
    if (req.url.startsWith('/reset')) {
      turns.clear();
      histories.clear();
      modelSockets = new WeakSet();
      modelConnections = 0;
      failures = [];
      measuring = false;
      measuredSockets = new WeakSet();
      measuredModelConnections = 0;
      const params = new URL(req.url, 'http://localhost').searchParams;
      oneShot = params.get('oneShot') === 'true';
      chain = params.get('chain') === 'true';
      longInput = params.get('longInput') === 'true';
      return res.end('ok');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    bytes += body.length;
    const request = JSON.parse(body);
    requests++;
    if (!modelSockets.has(req.socket)) {
      modelSockets.add(req.socket);
      modelConnections++;
    }
    if (measuring && !measuredSockets.has(req.socket)) {
      measuredSockets.add(req.socket);
      measuredModelConnections++;
    }
    assert.equal(request.model, 'gpt-5');
    const wire = JSON.stringify(request.input);
    const matches = [...wire.matchAll(/BENCH:([a-z0-9_-]+):(\d+):(\d+)/g)];
    assert(matches.length, 'Missing benchmark marker');
    const [, session, turn, toolCountText] = matches.at(-1);
    const toolCount = Number(toolCountText),
      key = `${session}:${turn}`;
    const step = turns.get(key) ?? 0;
    turns.set(key, step + 1);
    assert(
      step < (chain ? 9 : toolCount ? 2 : 1),
      'Unexpected repeated model request',
    );
    const id = `resp_${session}_${turn}_${step}`;
    const answer = `ANSWER:${session}:${turn}`.padEnd(
      Number(process.env.BENCH_OUTPUT_BYTES ?? 256),
      '.',
    );
    const prior = oneShot ? [] : (histories.get(session) ?? []);
    const users = request.input
      .filter((item) => item.role === 'user')
      .map(text);
    const assistants = request.input
      .filter((item) => item.role === 'assistant')
      .map(text);
    const currentInput = `BENCH:${session}:${turn}:${toolCount} ${longInput ? 'x'.repeat(1024) : 'hello'}`;
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
    let output;
    if (toolCount && (chain ? step < 8 : step === 0)) {
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
    const delay = Number(process.env.BENCH_MODEL_DELAY_MS ?? 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
});
server.listen(0, '127.0.0.1', () =>
  process.send({ port: server.address().port }),
);
process.on('message', (message) => {
  if (message === 'close') server.close(() => process.exit());
});
