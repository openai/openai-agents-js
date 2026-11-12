import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  OutputValidationError,
  ToolOutput,
  telemetry,
  tool,
} from '@openai/agents';
import {
  httpError,
  text,
  toolCall,
  withScriptedResponses,
} from '@openai/agents/testing';
import { startCollector } from './collector';
import { artifactJson, readHistory } from './history-reader';

type Scenario = 'tool' | 'tool-error' | 'validation' | 'provider' | 'retry';

async function exercise(scenario: Scenario) {
  const toolCalls: string[] = [];
  const callbackFailure = new Error('Synthetic catalog failure');
  let callback = 'not_called';
  const lookup = tool({
    name: 'lookup',
    description: 'Look up a synthetic record.',
    parameters: z.object({ record: z.string() }),
    execute: ({ record }) => {
      toolCalls.push(record);
      if (scenario === 'tool-error') {
        callback = 'returned_error';
        return new ToolOutput(
          [{ type: 'inputText', text: 'Synthetic catalog unavailable' }],
          false,
        );
      }
      callback = 'threw';
      throw callbackFailure;
    },
  });
  const lookupCall = [
    toolCall('lookup', { record: 'A' }, { callId: 'lookup-a' }),
  ];
  const responses = {
    provider: [httpError(400)],
    retry: [httpError(503), [text('Recovered after retry.')]],
    validation: [[text('{"count":"invalid"}')]],
    'tool-error': [lookupCall, [text('The catalog is unavailable.')]],
    tool: [lookupCall],
  }[scenario];

  return withScriptedResponses(responses, async (peer) => {
    const agent = new Agent<unknown, string | { count: number }>({
      name: 'Synthetic observability lesson',
      instructions: 'Use lookup when requested. Otherwise answer briefly.',
      provider: peer.provider,
      tools: scenario.startsWith('tool') ? [lookup] : [],
      ...(scenario === 'validation'
        ? {
            outputType: {
              mode: 'prompted' as const,
              schema: z.object({ count: z.number().int() }),
            },
          }
        : {}),
    });
    await using session = await agent.session();
    const turn = await session.submit(
      'Look up synthetic record A, or return a count.',
    );
    let outcome: string;
    let settlement:
      | { status: 'completed'; finalOutput: unknown }
      | { status: 'rejected'; errorType: string };
    let nativeError: {
      statusCode: number | null;
      code: string | null;
      requestId: string | null;
      category: string | null;
    } | null = null;
    try {
      const result = await turn.wait();
      outcome =
        callback === 'returned_error' ? 'tool_returned_error' : 'completed';
      settlement = { status: 'completed', finalOutput: result.finalOutput };
    } catch (error) {
      if (scenario === 'tool' && error === callbackFailure)
        outcome = 'tool_callback_exception';
      else if (
        scenario === 'validation' &&
        error instanceof OutputValidationError
      )
        outcome = 'output_validation_failure';
      else if (scenario === 'provider' && error instanceof NativeError) {
        outcome = 'provider_failure';
        nativeError = {
          statusCode: error.statusCode,
          code: error.code,
          requestId: error.requestId,
          category: error.category,
        };
      } else throw error;
      settlement = {
        status: 'rejected',
        errorType: error instanceof Error ? error.name : 'unknown',
      };
    }
    const history = await readHistory(session);
    return {
      scenario,
      outcome,
      sessionId: session.id,
      turnId: turn.turnId,
      toolCalls,
      callback,
      settlement,
      nativeError,
      providerRequests: peer.requests.length,
      ...(scenario === 'retry'
        ? { completedModelRequests: turn.runUsage.requests }
        : {}),
      history,
    };
  });
}

/** Run once in a fresh process, keeping the receiver alive through exporter shutdown. */
export async function walkthrough(scenario: Scenario) {
  const collector = await startCollector();
  const runId = `synthetic-${randomUUID()}`;
  let configured = false;
  let receipt: Awaited<ReturnType<typeof exercise>>;
  try {
    await telemetry.configure({
      traces: {
        kind: 'otlp-http',
        protocol: 'json',
        endpoint: `${collector.url}/v1/traces`,
      },
      logs: {
        kind: 'otlp-http',
        protocol: 'json',
        endpoint: `${collector.url}/v1/logs`,
      },
      spanAttributes: { 'example.run_id': runId },
      environment: 'synthetic-local',
    });
    configured = true;
    receipt = await exercise(scenario);
  } finally {
    try {
      if (configured) await telemetry.shutdown();
    } finally {
      await collector.close();
    }
  }
  const batches = collector.snapshot();
  if (
    !batches.some((batch) => batch.signal === 'traces') ||
    !batches.some((batch) => batch.signal === 'logs')
  ) {
    throw new Error(
      'No trace/log receipt: check endpoint and loopback proxy bypass',
    );
  }
  return { runId, receipt, batches };
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'tool-error' },
      output: { type: 'string', default: 'synthetic-trace.json' },
    },
  });
  const scenario = values.scenario ?? 'tool-error';
  const output = values.output ?? 'synthetic-trace.json';
  if (
    !['tool', 'tool-error', 'validation', 'provider', 'retry'].includes(
      scenario,
    )
  )
    throw new Error('Unknown synthetic scenario');
  const artifact = await walkthrough(scenario as Scenario);
  await writeFile(output, artifactJson(artifact), { mode: 0o600 });
  console.log(
    JSON.stringify({
      runId: artifact.runId,
      outcome: artifact.receipt.outcome,
      batchesReceived: artifact.batches.length,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      'Synthetic observability walkthrough failed. Check local fixture, exporter and output settings.',
    );
    process.exitCode = 1;
  });
}
