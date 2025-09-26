import OpenAI from 'openai';

async function generateToken() {
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const session = await openai.realtime.clientSecrets.create({
    session: {
      type: 'realtime',
      model: 'gpt-realtime',
    },
  });

  console.log(session.value);
}

generateToken().catch((err) => {
  console.error('Failed to create ephemeral token', err);
  process.exit(1);
});
