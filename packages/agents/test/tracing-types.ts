import type {
  Agent,
  Session,
  TraceOptions,
  TraceProcessor,
  FlushResult,
} from '../src';
import { telemetry } from '../src';

/** Declaration-only consumer; opens no native process owner. */
export async function tracingTypes(agent: Agent, session: Session) {
  const credential = new telemetry.TraceExportCredentials({
    headers: { Authorization: 'synthetic' },
  });
  const options: TraceOptions = {
    name: 'workflow',
    disabled: false,
    includeSensitiveData: false,
    metadata: { attempt: 1 },
    exportCredential: credential,
  };
  const handle: telemetry.TraceSpan = await telemetry.startTrace(options);
  await agent.session({ tracing: options });
  await agent.run('input', { tracing: options });
  await session.submit('input', {
    tracing: { parent: handle },
    ifBusy: 'reject',
  });
  await session.enqueue('input', undefined, { tracing: options });
  await session.executeCommand('/compact', { tracing: options });
  const processor: TraceProcessor = {
    onEvent: async (event) => {
      const id: string = event.trace_id;
      void id;
    },
  };
  await telemetry.configure({ traceProcessors: [processor] });
  await telemetry.addTraceProcessor(processor);
  await telemetry.setTraceProcessors([processor]);
  const result: FlushResult = await telemetry.forceFlush({ timeoutMs: 100 });
  const status: 'success' | 'partial' | 'timeout' | 'failure' = result.status;
  void status;
  // @ts-expect-error capture selection requires a boolean, not a policy string.
  const invalid: TraceOptions = { includeSensitiveData: 'all' };
  void invalid;
  handle.close();
  credential.close();
}
