/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {
  OPENAI_API_KEY: string;
}

import {
  Agent,
  BatchTraceProcessor,
  ConsoleSpanExporter,
  getGlobalTraceProvider,
  getCurrentTrace,
  run,
  Runner,
  setDefaultOpenAIKey,
  setTraceProcessors,
  withTrace,
} from '@openai/agents';
import { aisdk } from '@openai/agents-extensions';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      setDefaultOpenAIKey(env.OPENAI_API_KEY!);
      setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);
      const url = new URL(request.url);

      if (url.pathname === '/aisdk') {
        // AISDK-backed fake model used to validate context propagation without
        // hitting external services.
        return await withTrace('Cloudflare AISDK', async () => {
          const fakeModel = {
            provider: 'fake',
            modelId: 'fake-model',
            async doGenerate() {
              return {
                content: [{ type: 'text', text: 'hello' }],
                usage: { inputTokens: 1, outputTokens: 1 },
                providerMetadata: {},
              };
            },
          };

          const agent = new Agent({
            name: 'AISDK Agent',
            instructions: 'Respond with a short greeting.',
            model: aisdk(fakeModel as any),
          });

          const runner = new Runner({ tracingDisabled: true });
          const result = await runner.run(agent, 'ping');

          return new Response(
            `[AISDK_RESPONSE]${result.finalOutput}[/AISDK_RESPONSE]`,
          );
        });
      }

      if (url.pathname === '/als-propagation') {
        const report = await withTrace(
          'Cloudflare ALS propagation',
          async (trace) => {
            const matchesTrace = () =>
              getCurrentTrace()?.traceId === trace.traceId;
            const results: Record<string, boolean> = {
              sync: matchesTrace(),
            };

            await Promise.resolve().then(() => {
              results.promiseThen = matchesTrace();
            });

            await new Promise<void>((resolve) =>
              queueMicrotask(() => {
                results.queueMicrotask = matchesTrace();
                resolve();
              }),
            );

            await new Promise<void>((resolve) =>
              setTimeout(() => {
                results.setTimeout = matchesTrace();
                resolve();
              }, 0),
            );

            await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
            results.cryptoDigest = matchesTrace();

            const pullStream = new ReadableStream({
              pull(controller) {
                results.readablePull = matchesTrace();
                controller.enqueue('x');
                controller.close();
              },
            });
            await pullStream.getReader().read();

            const transform = new TransformStream({
              transform(chunk, controller) {
                results.transformStreamTransform = matchesTrace();
                controller.enqueue(chunk);
              },
              flush() {
                results.transformStreamFlush = matchesTrace();
              },
            });
            const source = new ReadableStream({
              start(controller) {
                controller.enqueue('y');
                controller.close();
              },
            });
            const transformed = source.pipeThrough(transform);
            const reader = transformed.getReader();
            await reader.read();
            await reader.read();

            return results;
          },
        );

        return new Response(JSON.stringify(report, null, 2), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }

      // Optionally wrap your code into a trace if you want to make multiple runs in a single trace
      return await withTrace('Cloudflare Worker', async () => {
        const agent = new Agent({
          name: 'Test Agent',
          instructions:
            'You will always only respond with "Hello there!". Not more not less.',
        });
        const result = await run(agent, 'Hey there!');

        return new Response(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
      });
    } catch (error) {
      console.error(error);
      return new Response(String(error), { status: 500 });
    } finally {
      // make sure to flush any remaining traces before exiting
      ctx.waitUntil(getGlobalTraceProvider().forceFlush());
    }
  },
} satisfies ExportedHandler<Env>;
