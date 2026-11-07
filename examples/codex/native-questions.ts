import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  type ElicitationRequest,
  type Interaction,
  type NativeQuestionReply,
  type Session,
  type UserVerificationRequest,
  type VerificationProof,
} from '@openai/agents';

// The application supplies its own renderer and returns offered values or null.
export type CollectFormValues = (
  description: string,
  schema: ElicitationRequest['schema'],
  signal: AbortSignal,
) => Promise<Parameters<ElicitationRequest['reply']>[0]>;

/** Collect form values without inferring the originating tool or turn. */
export function formQuestionHandler(collect: CollectFormValues) {
  return async (
    request: Interaction,
    signal: AbortSignal,
  ): Promise<NativeQuestionReply> => {
    if (request.type === 'action_requested')
      throw new Error('Expected a native question');
    signal.throwIfAborted();
    if (request.type === 'approval_request') return request.reply('deny');
    // This renderer collects form values, not verification proofs or URL consent.
    if (request.type !== 'elicitation_request') return request.reply(null);
    if (request.mode === 'url') return request.reply(null);
    const schema = request.schema;
    const values = await collect(request.description, schema, signal);
    signal.throwIfAborted();
    return request.reply(values);
  };
}

/** Read one live Session request, including Session-scoped URL requests. */
export async function answerNextSessionQuestion(
  session: Session,
  collect: CollectFormValues,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const reader = session.interactions();
  const abort = () => {
    void reader.return?.();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const next = await reader.next();
    signal.throwIfAborted();
    if (next.done) return false;
    const request = next.value;
    if (request.type === 'action_requested') {
      throw new Error(`Provide a manual tool handler for ${request.name}`);
    }
    const reply = await formQuestionHandler(collect)(request, signal);
    await session.respond(reply);
    return true;
  } finally {
    signal.removeEventListener('abort', abort);
    // Closing the reader does not answer a question or cancel its root.
    await reader.return?.();
  }
}

/**
 * Drive requests owned by this exact turn.
 * Run a Session reader for Session-scoped URL requests.
 */
export async function askWithQuestions(session: Session, input: string) {
  const turn = await session.submit(input);
  for (;;) {
    const result = await turn.wait({ until: 'interaction' });
    if (!('requests' in result)) return result;
    for (const request of result.requests) {
      if (request.type === 'action_requested') {
        // Manual tools need an application-specific result and validator.
        await turn.cancel();
        throw new Error(`No manual handler for ${request.name}`);
      }
      const reply =
        request.type === 'approval_request'
          ? request.reply('deny')
          : request.reply(null);
      await session.respond(reply);
    }
  }
}

/** Collect an explicit application decision. The SDK helper does not open or verify the URL. */
export type DecideURLConsent = (
  request: ElicitationRequest,
  signal: AbortSignal,
) => Promise<boolean>;

/**
 * Call from an application-owned Session reader, outside onInteraction.
 * Peer-reported completion does not prove authorization.
 */
export async function answerOwnedURL(
  session: Session,
  request: ElicitationRequest,
  decide: DecideURLConsent,
  options: { timeoutMs: number; signal: AbortSignal },
): Promise<'declined' | 'completed'> {
  options.signal.throwIfAborted();
  if (request.mode !== 'url') {
    throw new TypeError('An issued URL request is required');
  }
  const consent = await decide(request, options.signal);
  options.signal.throwIfAborted();
  if (!consent) {
    await session.respond(request.reply(null));
    return 'declined';
  }
  await session.respond(request.replyUrlAccept());
  await request.waitForCompletion(options);
  return 'completed';
}

/** Proof collection uses an explicitly configured application backend. */
export type CollectVerificationProof = (
  request: UserVerificationRequest,
  signal: AbortSignal,
) => Promise<VerificationProof | null>;

/**
 * Call from a Session reader; onInteraction callbacks return replies instead.
 * Proof delivery is not service acceptance.
 */
export async function answerVerificationRequest(
  session: Session,
  request: UserVerificationRequest,
  collect: CollectVerificationProof,
  signal: AbortSignal,
): Promise<'declined' | 'submitted'> {
  signal.throwIfAborted();
  const proof = await collect(request, signal);
  signal.throwIfAborted();
  await session.respond(request.reply(proof));
  return proof === null ? 'declined' : 'submitted';
}

/** Agent.run closes its session and joins the handler before returning. */
export async function askOnce(agent: Agent, input: string) {
  return agent.run(input, {
    onInteraction(request, signal) {
      if (request.type === 'action_requested')
        throw new Error('Unexpected manual request');

      signal.throwIfAborted();
      return request.type === 'approval_request'
        ? request.reply('deny')
        : request.reply(null);
    },
  });
}

/** The application owns input collection and must respect its abort signal. */
export async function askOnceWithForms(
  agent: Agent,
  input: string,
  collect: CollectFormValues,
) {
  return agent.run(input, { onInteraction: formQuestionHandler(collect) });
}

/** Run one task while a single application reader owns question delivery. */
export async function runQuestionSession(
  agent: Agent,
  input: string,
  handlers: {
    collectForm: CollectFormValues;
    decideURL: DecideURLConsent;
    collectProof: CollectVerificationProof;
  },
  timeoutMs = 60_000,
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError('timeoutMs must be positive and finite.');
  await using session = await agent.session();
  const reader = session.interactions();
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(
    () => controller.abort(new Error('Question task timed out.')),
    timeoutMs,
  );
  const stopped = Promise.withResolvers<never>();
  const detach = () => {
    void reader.return?.();
    stopped.reject(signal.reason);
  };
  signal.addEventListener('abort', detach, { once: true });
  const questions = (async () => {
    for await (const request of reader) {
      signal.throwIfAborted();
      if (request.type === 'action_requested')
        throw new Error(`No manual tool handler for ${request.name}`);
      if (request.type === 'user_verification_request') {
        await answerVerificationRequest(
          session,
          request,
          handlers.collectProof,
          signal,
        );
      } else if (
        request.type === 'elicitation_request' &&
        request.mode === 'url'
      ) {
        await answerOwnedURL(session, request, handlers.decideURL, {
          timeoutMs,
          signal,
        });
      } else {
        await session.respond(
          await formQuestionHandler(handlers.collectForm)(request, signal),
        );
      }
    }
    signal.throwIfAborted();
  })();
  // Observe a reader failure even while submit is waiting for Session startup.
  void questions.catch(() => {});
  try {
    const result = await Promise.race([
      stopped.promise,
      (async () => (await (await session.submit(input)).wait()).finalOutput)(),
      questions.then(() => {
        throw new Error('Question reader closed before the task settled.');
      }),
    ]);
    await reader.return?.();
    // Join accepted URL completion, while still allowing timeout to initiate close.
    await Promise.race([questions, stopped.promise]);
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort(new Error('Question reader finished.'));
    signal.removeEventListener('abort', detach);
    await reader.return?.();
    // Closing the Session stops and joins its native work; detaching a reader does not.
    try {
      await session.close();
    } finally {
      await questions.catch(() => {});
    }
  }
}

async function main(): Promise<void> {
  const { MCP_URL, MCP_TOOL, MCP_TOKEN } = process.env;
  if (!MCP_URL || !MCP_TOOL)
    throw new Error(
      'Set MCP_URL and MCP_TOOL to a configured URL-elicitation peer and tool.',
    );
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    await using provider = new NativeProvider({
      baseUrl: process.env.OPENAI_BASE_URL,
    });
    const agent = new Agent<undefined>({
      model: 'gpt-5.5',
      instructions: 'Use the configured MCP tool for the requested task.',
      tools: [
        new HttpMCP({
          name: 'account',
          url: MCP_URL,
          tools: [MCP_TOOL],
          bearerToken: MCP_TOKEN,
        }),
      ],
      provider,
    });
    const result = await runQuestionSession(
      agent,
      process.argv.slice(2).join(' ') || 'Use the configured account tool.',
      {
        async collectForm(description, _schema, signal) {
          // This small CLI declines forms; supply a schema-aware renderer in an app.
          signal.throwIfAborted();
          console.log(`Declining form: ${description}`);
          return null;
        },
        async decideURL(request, signal) {
          const url = request.url;
          if (url === null)
            throw new TypeError('The issued URL request has no URL.');
          // No automatic navigation. Complete any external-account flow explicitly.
          const decision = await terminal.question(
            `${request.description}\nURL: ${url}\nConsent to this configured peer's URL request? [yes/no] `,
            { signal },
          );
          return decision.trim().toLowerCase() === 'yes';
        },
        async collectProof(_request, signal) {
          signal.throwIfAborted();
          // An application can supply its configured proof backend here.
          return null;
        },
      },
    );
    console.log(result);
  } finally {
    terminal.close();
  }
}

// Requires Model credentials and a configured peer; this makes live calls.
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
