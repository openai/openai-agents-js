import { Agent, OpenAIConversationsSession, run } from '@openai/agents';

const agent = new Agent({
  name: 'TourGuide',
  instructions: 'Answer with compact travel facts.',
});

// Any object that implements the Session interface works here. This example uses
// the built-in OpenAIConversationsSession, but you can swap in a custom Session.
const session = new OpenAIConversationsSession();

const firstTurn = await run(agent, 'What city is the Golden Gate Bridge in?', {
  session,
});
console.log(firstTurn.finalOutput); // "San Francisco"

const secondTurn = await run(agent, 'What state is it in?', { session });
console.log(secondTurn.finalOutput); // "California"
