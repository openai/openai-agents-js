import { createServerFn } from '@tanstack/react-start';
import OpenAI from 'openai';

export async function getToken() {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const session = await openai.beta.realtime.sessions.create({
    model: 'gpt-4o-realtime-preview',
    // tracing: {
    //   workflow_name: 'Realtime Next Demo',
    // },
  });

  return session.client_secret.value;
}

// We need to use a server function to get the token because
// the token is used on the client
export const getTokenServerFn = createServerFn().handler(async () => {
  return getToken();
});
