import { useEffect, useState } from 'react';

import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents/classic';
import { RealtimeAgent } from '@openai/agents/realtime';
import OpenAI from 'openai';

setTracingDisabled(true);

const realtimeAgent = new RealtimeAgent({ name: 'Browser Realtime Agent' });

const openai = new OpenAI({
  // IMPORTANT: DO NOT DO THIS.
  // If you want to use the Agents SDK in the browser, you will need to set up your own proxy
  // that uses secure credentials. Do NOT use your OpenAI API key directly in the browser.
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true,
});

setDefaultOpenAIClient(openai);

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
});

function App() {
  const [result, setResult] = useState('');

  useEffect(() => {
    run(agent, 'Hey there!').then((result) => {
      setResult(`[RESPONSE]${result?.finalOutput ?? ''}[/RESPONSE]`);
    });
  }, []);

  return (
    <>
      <span data-testid="realtime-agent">{realtimeAgent.name}</span>
      {result ? <span data-testid="response">{result}</span> : null}
    </>
  );
}

export default App;
