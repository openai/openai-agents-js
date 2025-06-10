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
  run,
  setDefaultOpenAIKey,
  setTraceProcessors,
  withTrace,
} from '@openai/agents';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      setDefaultOpenAIKey(env.OPENAI_API_KEY!);
      setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);

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
