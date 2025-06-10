import { getGlobalTraceProvider } from '@openai/agents';

export default {
  // @ts-expect-error - Cloudflare Workers types are not typed
  async fetch(request, env, ctx): Promise<Response> {
    try {
      // your agent code here
      return new Response(`success`);
    } catch (error) {
      console.error(error);
      return new Response(String(error), { status: 500 });
    } finally {
      // make sure to flush any remaining traces before exiting
      ctx.waitUntil(getGlobalTraceProvider().forceFlush());
    }
  },
};
