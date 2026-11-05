import {
  Agent,
  NativeProvider,
  parseSessionState,
  type NativeProviderOptions,
  type SessionState,
} from '@openai/agents';

/** Continue a conversation, stream its second answer, and restore its idle state. */
export async function runConversation(
  options: NativeProviderOptions = {},
  onText: (delta: string) => void = () => {},
) {
  await using provider = new NativeProvider(options);
  const instructions = 'Answer briefly and remember this conversation.';
  const agent = new Agent({ instructions, provider });
  let saved: SessionState;
  let firstAnswer: string;
  let secondAnswer: string;
  const messages: Array<{ role: string; turnId: string }> = [];
  const turns: Array<{ id: string; status: string }> = [];
  {
    await using session = await agent.session();
    const first = await session.submit('I prefer vegetarian meals.');
    firstAnswer = (await first.wait()).finalOutput;
    const second = await session.submit('What would you suggest for dinner?');
    for await (const event of second.events()) {
      if (event.type === 'output_text_delta') onText(event.delta);
    }
    secondAnswer = (await second.wait()).finalOutput;

    for await (const item of session.items()) {
      if (item.type === 'message') {
        messages.push({ role: item.role, turnId: item.turnId });
      }
    }
    for await (const turn of session.turns()) {
      turns.push({ id: turn.id, status: turn.status });
    }
    saved = await session.saveState();
  }

  // The application supplies matching instructions and current credentials.
  const state = parseSessionState(JSON.stringify(saved));
  await using restored = await new Agent({ instructions, provider }).session({
    state,
  });
  const third = await restored.submit('What meal preference did I share?');
  const result = await third.wait();
  return {
    firstAnswer,
    secondAnswer,
    restoredAnswer: result.finalOutput,
    history: { messages, turns },
  };
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  runConversation({ baseUrl: process.env.OPENAI_BASE_URL }, (delta) =>
    process.stdout.write(delta),
  ).then(
    (result) => {
      console.log();
      console.log('Settled answer:', result.secondAnswer);
      console.log('Restored answer:', result.restoredAnswer);
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
