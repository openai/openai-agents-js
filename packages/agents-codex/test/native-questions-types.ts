import type {
  Agent,
  ApprovalRequest,
  Completed,
  ElicitationRequest,
  Interaction,
  ActionReply as ManualToolReply,
  ActionRequested as ManualToolRequest,
  NativeQuestionReply,
  PendingRequests,
  Session,
  Turn,
} from '../src';
import type { FunctionCallOutput } from '../src/runtime/input';

// Declaration-only consumer. It opens no native owner.
export async function questionTypes(
  agent: Agent,
  session: Session,
  turn: Turn,
  manual: ManualToolReply,
  raw: FunctionCallOutput,
  approval: ApprovalRequest,
  elicitation: ElicitationRequest,
) {
  const manualResponse: Promise<void> = session.respond(manual);
  const rawResponse: Promise<void> = session.respond(raw);
  const nativeResponse: Promise<void> = session.respond(approval.reply('deny'));
  const childId: string | null = approval.subagentId;
  const complete: Promise<Completed<string>> = turn.wait();
  const oldWait: Promise<Completed<string> | PendingRequests<string>> =
    turn.wait({ until: 'request' });
  const mixed: Promise<
    Completed<string> | PendingRequests<string, string, Interaction>
  > = turn.wait({ until: 'interaction' });
  const oldBatch = {} as PendingRequests<string>;
  const oldRequests: readonly ManualToolRequest[] = oldBatch.requests;
  const inventory: Promise<readonly Interaction[]> =
    session.pendingInteractions();
  const stream: AsyncIterableIterator<Interaction> = session.interactions();
  const negative: NativeQuestionReply = elicitation.reply(null);
  const form: NativeQuestionReply = elicitation.reply({ value: 'answer' });
  // Legacy form callbacks need no mode guard for an object reply.
  await agent.run('form input', {
    onNativeQuestion: (request) =>
      request.type === 'approval_request'
        ? request.reply('deny')
        : request.type === 'elicitation_request'
          ? request.reply({ value: 'answer' })
          : request.reply(null),
  });
  if (elicitation.mode === 'url') {
    const consent: NativeQuestionReply = elicitation.replyUrlAccept();
    const completion: Promise<void> = elicitation.waitForCompletion({
      timeoutMs: 100,
    });
    void consent;
    void completion;
  }
  // @ts-expect-error Form replies require a JSON object, not a scalar value.
  elicitation.reply('answer');
  // @ts-expect-error Replies are opaque, not structural JSON or raw operations.
  const forged: NativeQuestionReply = {};
  // @ts-expect-error Enqueue has no boolean acceptance/effect receipt.
  const boolean: Promise<boolean> = session.respond(
    approval.reply('allow_once'),
  );
  // @ts-expect-error Persistent decisions are outside this limited approval API.
  approval.reply('allow_always');
  await agent.run('input', {
    onInteraction: (request) => request.reply('manual result'),
    onNativeQuestion: (request) =>
      request.type === 'approval_request'
        ? request.reply('deny')
        : request.reply(null),
  });
  return {
    manualResponse,
    rawResponse,
    nativeResponse,
    childId,
    complete,
    oldWait,
    mixed,
    oldRequests,
    inventory,
    stream,
    negative,
    form,
    forged,
    boolean,
  };
}
