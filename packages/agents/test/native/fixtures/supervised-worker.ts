import { MCPServerStreamableHttp } from '@openai/agents/classic';
import type { ReconciledCall } from '@openai/agents';
import { superviseArtifact } from '../../../examples/supervised-worker/worker';

const config = JSON.parse(process.argv[2]) as {
  directory: string;
  modelUrl: string;
  reportsUrl: string;
  reportsToken: string;
  task: string;
  steer?: string;
  stopAfterEffect?: boolean;
  turnMs?: number;
  confirmedCallId?: string;
};

async function main() {
  const reports = new MCPServerStreamableHttp({
    name: 'reports',
    url: config.reportsUrl,
    timeout: 5_000,
    requestInit: {
      headers: { Authorization: 'Bearer ' + config.reportsToken },
    },
    onToolEnd: async ({ callId }) => {
      if (!config.stopAfterEffect) return;
      process.send?.({ type: 'effect', callId });
      // Stop exactly after the peer recorded the effect but before the SDK
      // obtains the callback result. The test supervisor owns this process.
      await new Promise(() => {});
    },
  });
  try {
    await reports.connect();
    const result = await superviseArtifact({
      directory: config.directory,
      provider: {
        baseUrl: config.modelUrl,
        apiKey: 'synthetic-supervised-worker',
        supportsWebsockets: false,
      },
      reports: { name: 'reports', server: reports },
      model: 'gpt-5.5',
      task: config.task,
      ...(config.steer === undefined ? {} : { steer: config.steer }),
      ...(config.turnMs === undefined ? {} : { turnMs: config.turnMs }),
      reconcile: async (call): Promise<ReconciledCall | undefined> => {
        if (call.callId !== config.confirmedCallId) return undefined;
        return {
          threadId: call.threadId,
          turnId: call.turnId,
          callId: call.callId,
          outcome: 'applied',
          result:
            'The application confirmed that this synthetic report was recorded.',
        };
      },
    });
    process.send?.({ type: 'result', result });
  } finally {
    await reports.close();
  }
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.disconnect?.());
