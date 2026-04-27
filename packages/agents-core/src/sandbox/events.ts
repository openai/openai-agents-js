export type SandboxEventPhase = 'start' | 'end' | 'error';

export type SandboxEventError = {
  name?: string;
  message: string;
  code?: string;
};

export type SandboxOperationEvent = {
  type: 'sandbox_operation';
  name: string;
  phase: SandboxEventPhase;
  timestamp: string;
  data?: Record<string, unknown>;
  durationMs?: number;
  error?: SandboxEventError;
};

export type SandboxEvent = SandboxOperationEvent;

export type SandboxEventSink = (event: SandboxEvent) => void | Promise<void>;

export type SandboxJsonlEventWriter = (line: string) => void | Promise<void>;

export type SandboxHttpEventRequest = {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
};

export type SandboxHttpEventResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  text?: () => Promise<string>;
};

export type SandboxHttpEventFetch = (
  endpoint: string,
  request: SandboxHttpEventRequest,
) => Promise<SandboxHttpEventResponse>;

export type SandboxHttpEventSinkOptions = {
  endpoint: string;
  fetch?: SandboxHttpEventFetch;
  headers?: Record<string, string>;
};

const sandboxEventSinks = new Set<SandboxEventSink>();

export function addSandboxEventSink(sink: SandboxEventSink): () => void {
  sandboxEventSinks.add(sink);
  return () => {
    sandboxEventSinks.delete(sink);
  };
}

export function clearSandboxEventSinks(): void {
  sandboxEventSinks.clear();
}

export async function emitSandboxEvent(event: SandboxEvent): Promise<void> {
  if (sandboxEventSinks.size === 0) {
    return;
  }

  await Promise.allSettled(
    [...sandboxEventSinks].map(async (sink) => {
      await sink(event);
    }),
  );
}

/**
 * Create a sink that writes one serialized sandbox event per JSONL line.
 */
export function createSandboxJsonlEventSink(
  writer: SandboxJsonlEventWriter,
): SandboxEventSink {
  return async (event) => {
    await writer(`${JSON.stringify(event)}\n`);
  };
}

/**
 * Create a sink that POSTs each sandbox event as JSON to an HTTP endpoint.
 */
export function createSandboxHttpEventSink(
  options: SandboxHttpEventSinkOptions,
): SandboxEventSink {
  return async (event) => {
    const fetch = options.fetch ?? readGlobalFetch();
    if (!fetch) {
      throw new Error(
        'No fetch implementation is available for the sandbox HTTP event sink.',
      );
    }

    const response = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const detail = await readHttpErrorDetail(response);
      throw new Error(
        `Sandbox event HTTP sink failed with status ${response.status}${detail}`,
      );
    }
  };
}

/**
 * Create a sink that delivers each event to multiple child sinks.
 */
export function createChainedSandboxEventSink(
  ...sinks: SandboxEventSink[]
): SandboxEventSink {
  return async (event) => {
    await Promise.allSettled(
      sinks.map(async (sink) => {
        await sink(event);
      }),
    );
  };
}

export function serializeSandboxEventError(error: unknown): SandboxEventError {
  if (error instanceof Error) {
    const code = readErrorCode(error);
    return {
      name: error.name,
      message: error.message,
      ...(code ? { code } : {}),
    };
  }

  return {
    message: String(error),
  };
}

function readErrorCode(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function readGlobalFetch(): SandboxHttpEventFetch | undefined {
  return (globalThis as { fetch?: SandboxHttpEventFetch }).fetch;
}

async function readHttpErrorDetail(
  response: SandboxHttpEventResponse,
): Promise<string> {
  if (typeof response.text !== 'function') {
    return response.statusText ? `: ${response.statusText}` : '';
  }

  try {
    const text = await response.text();
    if (text) {
      return `: ${text}`;
    }
  } catch {
    // Ignore response body read failures and use the status text below.
  }

  return response.statusText ? `: ${response.statusText}` : '';
}
