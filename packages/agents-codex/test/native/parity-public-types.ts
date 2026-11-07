import {
  Agent,
  Runner,
  type Completed,
  type ChildTurn,
  type ElicitationRequest,
  type FunctionTool,
  type Session,
} from '../../src';

// This file is checked by tsconfig.test.json and is never executed.
export function contextualAgent(
  agent: Agent<{ account: string }, { answer: number }>,
) {
  // @ts-expect-error A context-dependent agent cannot open without context.
  agent.session();
  // @ts-expect-error One-shot runs require the same application context.
  agent.run('answer');
  // @ts-expect-error Runner preserves the agent context requirement.
  Runner.run(agent, 'answer');
  const session: Promise<Session<{ answer: number }>> = agent.session({
    context: { account: 'a' },
  });
  const result: Promise<Completed<{ answer: number }>> = Runner.run(
    agent,
    'answer',
    { context: { account: 'a' } },
  );
  return { session, result };
}

export function contextFreeAgent(agent: Agent) {
  return [agent.session(), agent.run('answer'), Runner.run(agent, 'answer')];
}

export async function replaceContextualTool(
  agent: Agent<{ account: string }>,
  accountTool: FunctionTool<{ account: string }>,
  cartTool: FunctionTool<{ cart: number[] }>,
) {
  const session = await agent.session({ context: { account: 'a' } });
  await session.update({ tools: [accountTool] });
  const outputOnly: Session<string> = session;
  await outputOnly.update({ tools: [accountTool] });
  // @ts-expect-error Replacement tools receive the session's original context.
  await session.update({ tools: [cartTool] });
}

// Child result handles never regain unsupported root controls.
export async function childControls(child: ChildTurn) {
  const completed = await child.wait();
  // @ts-expect-error Root cancellation is not a child capability.
  child.cancel();
  // @ts-expect-error JS child steering is not supported.
  child.steer('new input');
  // @ts-expect-error Exact root steering is not a child capability.
  child.steerExact('new input', 'native-id');
  // @ts-expect-error Completed.turn keeps the child view.
  completed.turn.cancel();
}

export function elicitationModes(request: ElicitationRequest) {
  if (request.mode === 'form') {
    // @ts-expect-error Forms have no URL completion observer.
    request.waitForCompletion();
    // @ts-expect-error Forms cannot grant URL consent.
    request.replyUrlAccept();
  } else {
    // @ts-expect-error URL replies cannot contain form answers.
    request.reply({ answer: true });
  }
}
