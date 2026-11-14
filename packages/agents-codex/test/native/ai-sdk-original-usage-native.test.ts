import type { Session as RuntimeSession } from '../../src/runtime/session';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGateway } from '@ai-sdk/gateway';
import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
it.each([
  ['google', false, false],
  ['google', true, false],
  ['gateway', false, false],
  ['gateway', true, false],
  ['google', false, true],
] as const)(
  'settles %s original SDK usage, stream=%s, forgedID=%s',
  async (kind, stream, forgedID) => {
    const wires: unknown[] = [];
    const vendor = { microUnits: 21, nested: [0, null, false] };
    const googleUsage = {
      promptTokenCount: 3,
      candidatesTokenCount: 2,
      totalTokenCount: 5,
      cachedContentTokenCount: 1,
      trafficType: 'ON_DEMAND',
      vendorPricing: vendor,
    };
    const gatewayUsage = {
      inputTokens: { total: 3, noCache: 2, cacheRead: 1, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
      raw: { vendorPricing: vendor },
    };
    const google = {
      responseId: 'google-usage-1',
      modelVersion: 'gemini-2.5-flash',
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'usage accepted' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: googleUsage,
    };
    const gateway = {
      content: [{ type: 'text', text: 'usage accepted' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: gatewayUsage,
      warnings: [],
    };
    const server = createServer(async (req, res) => {
      let bytes = '';
      for await (const c of req) bytes += c;
      wires.push({ url: req.url, body: JSON.parse(bytes) });
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(kind === 'google' ? google : gateway));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const parts =
        kind === 'google'
          ? [google]
          : [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'text1' },
              { type: 'text-delta', id: 'text1', delta: 'usage accepted' },
              { type: 'text-end', id: 'text1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: gatewayUsage,
              },
            ];
      res.end(parts.map((p) => 'data: ' + JSON.stringify(p) + '\n\n').join(''));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const a = server.address();
      if (!a || typeof a === 'string') throw Error('bad address');
      const base = 'http://127.0.0.1:' + a.port;
      const peer =
        kind === 'google'
          ? createGoogleGenerativeAI({
              apiKey: 'local-fixture',
              baseURL: base + '/v1beta',
            })('gemini-2.5-flash')
          : createGateway({
              apiKey: 'local-fixture',
              baseURL: base,
            }).languageModel('openai/gpt-5');
      const expected =
        kind === 'google'
          ? {
              inputTokens: { total: 3, noCache: 2, cacheRead: 1 },
              outputTokens: { total: 2, text: 2, reasoning: 0 },
              raw: googleUsage,
            }
          : gatewayUsage;
      const model = new AiSdkModel(peer, {}, { stream });
      if (forgedID) {
        const complete = model.complete.bind(model);
        Object.defineProperty(model, 'complete', {
          value: async (request: Parameters<typeof complete>[0]) => {
            const response = await complete(request);
            Object.assign(response, { responseId: 'forged-provider-id' });
            return response;
          },
        });
      }
      await using provider = new NativeProvider({ modelBackend: model });
      const agent = new Agent({
        provider,
        model: 'usage-fixture',
        instructions: 'Respond.',
      });
      if (forgedID) {
        await expect(
          agent.run('Begin.', { returnRawUsage: true }),
        ).rejects.toThrow('Native model producer failed');
        expect(wires).toHaveLength(1);
        return;
      }
      const result = await agent.run('Begin.', {
        returnRawUsage: true,
        returnHistory: true,
        returnState: true,
      });
      expect(result.finalOutput).toBe('usage accepted');
      expect(result.rawUsage).toHaveLength(1);
      expect(result.rawUsage![0].usage).toEqual(expected);
      if (kind === 'google')
        expect(result.rawUsage![0].responseId).toBe('google-usage-1');
      else expect(result.rawUsage![0].responseId).not.toBe('FAKE_ID');
      expect(result.runUsage).toMatchObject({
        requests: 1,
        inputTokens: 3,
        cachedInputTokens: 1,
        outputTokens: 2,
        totalTokens: 5,
      });
      expect(result.state).not.toContain('__sdk_ai_sdk_original_usage');
      // Google's existing replay sidecar includes its SDK usageMetadata even
      // without raw-usage opt-in. Original usage must not change that contract.
      if (kind === 'google') expect(result.state).toContain('vendorPricing');
      else expect(result.state).not.toContain('vendorPricing');
      expect(JSON.stringify(result.history)).not.toContain('vendorPricing');
      const restored = await agent.run('Continue.', {
        state: result.state,
        returnHistory: true,
        returnState: true,
      });
      expect(restored).not.toHaveProperty('rawUsage');
      expect(restored.state).not.toContain('__sdk_ai_sdk_original_usage');
      if (kind === 'google') expect(restored.state).toContain('vendorPricing');
      else expect(restored.state).not.toContain('vendorPricing');
      expect(JSON.stringify(restored.history)).not.toContain('vendorPricing');
      expect(wires).toHaveLength(2);
      expect(JSON.stringify(wires[1])).not.toContain('vendorPricing');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
  30000,
);

it.each([false, true])(
  'does not publish original usage for a rejected final response, stream=%s',
  async (stream) => {
    const server = createServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      const frame = {
        responseId: 'rejected-sdk-response',
        modelVersion: 'gemini-2.5-flash',
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts: [{ text: 'partial' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: {
          promptTokenCount: 3,
          candidatesTokenCount: 2,
          totalTokenCount: 5,
          vendorPricing: { microUnits: 21 },
        },
      };
      res.writeHead(200, {
        'content-type': stream ? 'text/event-stream' : 'application/json',
      });
      res.end(
        stream
          ? 'data: ' + JSON.stringify(frame) + '\n\n'
          : JSON.stringify(frame),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw Error('Missing listener');
      const peer = createGoogleGenerativeAI({
        apiKey: 'local-fixture',
        baseURL: 'http://127.0.0.1:' + address.port + '/v1beta',
      })('gemini-2.5-flash');
      await using provider = new NativeProvider({
        modelBackend: new AiSdkModel(peer, {}, { stream }),
      });
      await using session = await new Agent({
        provider,
        model: 'usage-fixture',
        instructions: 'Respond.',
      }).session();
      (session as RuntimeSession<string, undefined>)._startRawUsage();
      const turn = await session.submit('Begin.');
      await expect(turn.wait()).rejects.toThrow();
      expect(
        (session as RuntimeSession<string, undefined>)._takeRawUsage(
          turn.turnId,
        ),
      ).toEqual([]);
      expect(JSON.stringify(await session.saveState())).not.toContain(
        'vendorPricing',
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
  30000,
);
